import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-interject-'));
const originalNow = Date.now;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const store = await load('main/metaAgent/messageStore.ts');
  const { deliverAgentMessage } = await load('main/messages/deliver.ts');
  const { MailboxWakes } = await load('main/messages/wake.ts');
  const { interjectHostNotification } = await load('main/agentSession/piInterject.ts');
  let noHistoryListener, noHistoryAccepted = false;
  const noHistory = { isStreaming: true, subscribe(fn) { noHistoryListener = fn; return () => {}; },
    async sendCustomMessage(message) { noHistoryListener({ type: 'message_end', message }); } };
  await assert.rejects(interjectHostNotification(noHistory, {
    prepare: () => ({ ids: ['x'], summary: 'x', content: 'x' }), accepted: () => { noHistoryAccepted = true; }
  }, () => true, () => {}), /无法核验 PI 会话历史/);
  assert.equal(noHistoryAccepted, false, 'a message event alone is not a durable receipt');
  let now = originalNow(), busy = true, reject = false, interjects = 0, idleWakes = 0, submitted;
  Date.now = () => now;
  store.setAgentMessagesUserDataDir(path.join(tmp, 'user'));
  let listener, entries = [];
  const pi = { isStreaming: true, subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    sessionManager: { getEntries: () => entries },
    async sendCustomMessage(message, options) {
      assert.equal(options.deliverAs, 'steer'); assert.equal(message.display, false);
      if (reject) throw new Error('rejected');
      submitted = message;
      queueMicrotask(() => { const cb = listener; cb?.({ type: 'message_end', message });
        entries.push({ type: 'custom_message', customType: message.customType, details: message.details }); });
    } };
  const ctx = { workspaces: { list: () => [{ id: 'w', path: tmp }] },
    sessions: { get: () => undefined, broadcastMessagesChanged() {} },
    orchestrator: { isBusy: () => busy, getHumanWait: () => null,
      async interjectHostNotification(_ws, delivery) { interjects++; return interjectHostNotification(pi, delivery, () => busy, () => {}); } } };
  const wakes = new MailboxWakes(ctx, async (_ctx, _recipient, _ws, _text, _id, _needed, options) => {
    if (busy) return false;
    idleWakes++; const batch = await options.notification.prepare(); if (batch) await options.notification.accepted(batch);
    return true;
  });
  let n = 0;
  const event = async digest => deliverAgentMessage(ctx, { from: 'host', to: 'orchestrator:w', workspaceId: 'w',
    text: JSON.stringify({type:'event-subscription',eventType:'issue',source:'gitlab',summary:'issue',data:{eventId:`e${++n}`,untrusted:true}}),
    meta: { hostNotification: {kind:'event',eventId:`e${n}`}, subscriptionEvent:true, ...(digest ? {digest:true} : {}) } });
  const rows = () => store.readAgentMessageLedger(tmp, 'w').messages;
  await event(false); await wakes.flush('orchestrator:w','w');
  assert.equal(interjects,0,'merge window holds'); now += 46000;
  await wakes.flush('orchestrator:w','w');
  assert.equal(interjects,1); assert.match(submitted.content,/events.read/); assert.match(submitted.content,/untrusted/);
  assert.equal(rows()[0].deliveryMethod,'steered'); assert.equal(rows()[0].read,true);
  busy=false; await event(false); now += 46000; await wakes.flush('orchestrator:w','w');
  assert.equal(idleWakes,1); assert.equal(rows()[1].deliveryMethod,'sent');
  busy=true; reject=true; await event(false); now += 46000; await wakes.flush('orchestrator:w','w');
  assert.equal(rows()[2].wakeUncertain,true, 'a failed native submission may already have entered the engine');
  assert.equal(rows()[2].read,false);
  await wakes.flush('orchestrator:w','w'); assert.equal(interjects,2,'uncertain delivery does not retry interjection');
  busy=false; await wakes.flush('orchestrator:w','w'); assert.equal(rows()[2].read,false, 'uncertain subscription delivery is not replayed on idle');
  busy=true; await event(true); now += 46000; await wakes.flush('orchestrator:w','w');
  assert.equal(interjects,2,'digest never wakes independently'); assert.equal(rows()[3].read,false);
  wakes.dispose();
} finally { Date.now = originalNow; fs.rmSync(tmp,{recursive:true,force:true,maxRetries:3}); }
console.log('subscription-interject: ok');
