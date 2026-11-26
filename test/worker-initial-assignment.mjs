import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-initial-assignment-'));
const compile = createSharedCompiler(root, tmp);
const load = source => import(pathToFileURL(compile(source)).href);
const store = await load('main/metaAgent/messageStore.ts');
const { reserveInitialAssignment, sendSessionMail } = await load('main/messages/assignment.ts');
const { attachMailboxWakes, flushMailboxWake } = await load('main/messages/wake.ts');
const { readMailbox } = await load('main/messages/read.ts');
const { runAsSchedulerTool } = await load('main/agent/agentScope.ts');
const { deliverAgentMessage } = await load('main/messages/deliver.ts');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixture(t) {
  const workspaceId = 'fixture';
  const dir = fs.mkdtempSync(path.join(tmp, 'world-'));
  store.setAgentMessagesUserDataDir(dir);
  const session = { id: 'gui', name: 'GUI fixture', runtime: 'pi', workspaceId, lifecycle: 'idle' };
  const sent = [];
  const ctx = {
    sessions: { get: id => id === session.id ? session : undefined, isChatRuntime: runtime => runtime === 'pi',
      onLifecycle: () => () => {}, broadcastMessagesChanged() {} },
    workspaces: { list: () => [{ id: workspaceId, path: dir }] },
    agentSessions: { isOpen: () => true, isBusy: () => false,
      send: async (id, text, images, opts) => {
        sent.push({ id, text, images, opts });
        return { ok: true };
      } },
    resolveBubbleWorkspaceId: () => workspaceId
  };
  t.after(attachMailboxWakes(ctx));
  return { ctx, session, sent, workspaceId, dir,
    ledger: () => store.readAgentMessageLedger(dir, workspaceId).messages,
    assign: text => sendSessionMail(ctx, { sessionId: session.id, text, idempotencyKey: 'initial-assignment',
      reuseExisting: true, initialAssignment: true }),
    flush: () => flushMailboxWake(ctx, session.id, workspaceId),
    reserve: turn => reserveInitialAssignment(ctx, session.id, turn),
    read: args => readMailbox(ctx, args, { id: session.id, hostView: false, workspaceId }) };
}

test('a short GUI assignment starts one host turn and confirms the body separately from read', async t => {
  const f = fixture(t);
  assert.equal(await f.reserve('empty'), undefined);
  await f.flush();
  assert.equal(f.sent.length, 0, 'an empty GUI session has no model turn');
  const stored = await f.assign('Implement the exact short task.');
  await f.flush();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].opts.messageId, /^assignment-start-/);
  assert.doesNotMatch(f.sent[0].text, /mail\.read/);
  assert.equal(f.ledger()[0].initialAssignmentReceipt, undefined, 'host admission is not an engine receipt');
  const delivery = await f.reserve(f.sent[0].opts.messageId);
  assert.match(delivery.prefix, /Implement the exact short task\./);
  assert.ok(delivery.prefix.includes(stored.messageId));
  assert.doesNotMatch(delivery.prefix, /mail\.read/);
  assert.equal(await f.reserve('another-turn'), undefined);
  assert.equal(f.ledger()[0].initialAssignmentReceipt.deliveredAt, undefined);
  await delivery.confirm();
  await delivery.rejectBeforeSubmission();
  assert.ok(f.ledger()[0].initialAssignmentReceipt.deliveredAt);
  assert.equal(f.ledger()[0].read, false, 'engine receipt does not stand in for explicit read');
  assert.equal(f.ledger()[0].notifiedAt, undefined, 'body delivery and a read reminder are separate');
  await f.flush();
  assert.equal(f.sent.length, 1);

  await sendSessionMail(f.ctx, { sessionId: f.session.id, text: 'A normal follow-up' });
  await f.flush();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].text, /1 封新信.*host\.mail\.read/);
  assert.equal(f.ledger()[1].read, false);
});

test('long escaped assignment continuation is exact and survives a retry with a different actor', async t => {
  const f = fixture(t);
  const body = ('\"\n😺'.repeat(2500)) + 'the end';
  const [first, retry] = await Promise.all([f.assign(body), runAsSchedulerTool(() => f.assign(body + 'ignored'))]);
  assert.equal(first.messageId, retry.messageId);
  assert.equal(f.ledger().length, 1);
  assert.equal(f.ledger()[0].from, 'host');
  const [old, duplicate] = await Promise.all([f.reserve('old'), f.reserve('duplicate')]);
  assert.ok(old);
  assert.equal(duplicate, undefined);
  await old.rejectBeforeSubmission();
  const current = await f.reserve('current');
  assert.ok(current);
  assert.ok(current.prefix.length < 4500, 'including escaping and continuation, input is bounded');
  await old.confirm();
  assert.equal(f.ledger()[0].initialAssignmentReceipt.deliveredAt, undefined, 'stale callback cannot confirm newer reservation');
  const statusBeforeRead = (await f.read({ includeBody: false })).messages[0].initialAssignment;
  assert.deepEqual(statusBeforeRead, { state: 'unconfirmed' });
  store.resetMessageStoreChainsForTest();
  assert.equal(await f.reserve('after-restart'), undefined, 'unknown native submission is never replayed');
  await current.confirm();
  const receipt = f.ledger()[0].initialAssignmentReceipt;
  assert.match(current.prefix, new RegExp(`"bodyOffset":${receipt.bodyEnd}\\b`));
  const firstPage = JSON.parse(current.prefix.split('\n').find(line => line.startsWith('Task body: ')).slice('Task body: '.length));
  assert.equal(firstPage.length, receipt.bodyEnd);
  assert.doesNotMatch(firstPage, /[\uD800-\uDBFF]$/);
  let text = firstPage;
  let bodyOffset = receipt.bodyEnd;
  while (bodyOffset !== null) {
    const page = await f.read({ messageId: first.messageId, mailboxWorkspaceId: f.workspaceId, bodyOffset });
    assert.equal(page.initialAssignment.state, 'delivered');
    assert.equal(page.read, true);
    text += page.text;
    bodyOffset = page.nextOffset;
  }
  assert.equal(text, body);
});

test('legacy first mail retains its body and original ID', async t => {
  const f = fixture(t);
  f.session.meta = { creationKey: 'legacy-workflow' };
  const legacy = await sendSessionMail(f.ctx, { sessionId: f.session.id, text: 'old assignment',
    idempotencyKey: 'initial-assignment', reuseExisting: true });
  const replay = await runAsSchedulerTool(() => f.assign('new task text must not replace old assignment'));
  assert.equal(replay.messageId, legacy.messageId);
  assert.equal(f.ledger().length, 1);
  assert.equal(f.ledger()[0].meta?.initialAssignment, undefined);
  assert.equal((await f.read({ messageId: legacy.messageId })).text, 'old assignment');
  assert.equal(await f.reserve('legacy'), undefined);
});

test('ordinary mail from another sender cannot claim the legacy assignment key', async t => {
  const f = fixture(t);
  await deliverAgentMessage(f.ctx, { from: 'unrelated-worker', to: f.session.id, workspaceId: f.workspaceId,
    text: 'unrelated mail', idempotencyKey: 'initial-assignment' });
  const task = await f.assign('actual delegated work');
  assert.equal(f.ledger().length, 2);
  assert.equal(f.ledger().find(message => message.id === task.messageId).meta?.initialAssignment, true);
  assert.match((await f.reserve('first-turn')).prefix, /actual delegated work/);
});

test('an explicit read before native submission suppresses the kickoff payload', async t => {
  const f = fixture(t);
  const stored = await f.assign('Read before the pending turn');
  await f.flush();
  assert.equal(f.sent.length, 1);
  await f.read({ messageId: stored.messageId });
  assert.equal(await f.reserve(f.sent[0].opts.messageId), undefined);
  assert.equal(f.ledger()[0].read, true);
  assert.equal(f.ledger()[0].initialAssignmentReceipt, undefined);
});
