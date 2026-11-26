import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-mailbox-'));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const load = entry => import(pathToFileURL(compile(entry)).href);
const store = await load('main/metaAgent/messageStore.ts');
const { MailboxWakes } = await load('main/messages/wake.ts');
let sequence = 0;
function world() {
  const root = path.join(temp, `world-${++sequence}`); fs.mkdirSync(root);
  store.setAgentMessagesUserDataDir(root);
  const target = { id: 'recipient', runtime: 'pi', lifecycle: 'idle', workspaceId: 'ws' };
  const ctx = { workspaces: { list: () => [{ id: 'ws', path: root }] },
    sessions: { get: id => id === target.id ? target : undefined, isChatRuntime: () => true, broadcastMessagesChanged() {} },
    agentSessions: { isBusy: () => false } };
  const seed = id => store.appendAgentMessageToStore(root, 'ws', { id, from: 'sender', to: target.id,
    kind: 'notice', text: id, ts: Date.now(), receipt: 'stored' });
  return { root, ctx, seed, ledger: () => store.readAgentMessageLedger(root, 'ws') };
}
try {
  {
    const w = world(); await w.seed('same'); let sent = 0;
    const sender = async () => { sent++; await new Promise(resolve => setTimeout(resolve, 5)); return true; };
    const first = new MailboxWakes(w.ctx, sender), second = new MailboxWakes(w.ctx, sender);
    await Promise.all([first.flush('recipient', 'ws'), second.flush('recipient', 'ws')]);
    assert.equal(sent, 1, 'independent services share actual recipient admission');
    assert.ok(w.ledger().messages[0].notifiedAt);
    first.dispose(); second.dispose();
  }
  {
    const w = world(); await w.seed('retry'); let sent = 0;
    const wakes = new MailboxWakes(w.ctx, async () => ++sent > 1, [100000]);
    await wakes.flush('recipient', 'ws');
    assert.equal(w.ledger().messages[0].wakeUncertain, undefined);
    await wakes.flush('recipient', 'ws');
    assert.equal(sent, 2, 'definite deferred admission remains retryable with the same request ID');
    assert.ok(w.ledger().messages[0].notifiedAt); wakes.dispose();
  }
  {
    const w = world(); const oldLetter = await w.seed('old');
    const calls = [];
    const db = new DatabaseSync(store.agentMessagesFilePath('ws'));
    db.exec("CREATE TRIGGER fail_wake_receipt BEFORE UPDATE ON mailbox_message WHEN json_extract(NEW.entry_json, '$.notifiedAt') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END;");
    const sender = async () => {
      calls.push(w.ledger().messages.filter(message => !message.notifiedAt).map(message => message.id));
      return { status: 'accepted', method: 'sent' };
    };
    const first = new MailboxWakes(w.ctx, sender, [100000]);
    try { await first.flush('recipient', 'ws'); }
    finally {
      first.dispose();
      db.exec('DROP TRIGGER fail_wake_receipt');
      db.close();
    }
    assert.equal(w.ledger().messages[0].notifiedAt, undefined);
    const newLetter = await w.seed('new');
    const restarted = new MailboxWakes({ ...w.ctx }, async () => {
      calls.push(w.ledger().messages.filter(message => !message.notifiedAt).map(message => message.id));
      return { status: 'accepted', method: 'sent' };
    });
    await restarted.flush('recipient', 'ws'); restarted.dispose();
    assert.deepEqual(calls, [[oldLetter.id], [newLetter.id]], 'durable acceptance repairs the old receipt before planning a larger new batch');
    assert.ok(w.ledger().messages.every(message => message.notifiedAt));
  }
  {
    const w = world(); await w.seed('unknown'); let sent = 0;
    const first = new MailboxWakes(w.ctx, async () => { sent++; throw Object.assign(new Error('submission lost'), { deliveryUncertain: true }); });
    await first.flush('recipient', 'ws'); first.dispose();
    const restarted = new MailboxWakes({ ...w.ctx }, async () => { sent++; return true; });
    await restarted.flush('recipient', 'ws'); restarted.dispose();
    assert.equal(sent, 1);
    assert.equal(w.ledger().messages[0].wakeUncertain, true, 'unknown delivery is visible in mailbox metadata');
    assert.equal(w.ledger().messages[0].notifiedAt, undefined);
  }
  console.log('semantic-mailbox-wake: concurrent admission, deferred retry, committed receipt repair and unknown recovery passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
