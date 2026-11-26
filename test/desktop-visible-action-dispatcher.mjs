import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'desktop-visible-dispatch-'));
let runtime, receipts;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { createVisibleActionRuntime } = await import(pathToFileURL(compile('main/desktop/visibleActionFactory.ts')));
  const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
  const { VisibleActionDispatcher } = await import(pathToFileURL(compile('main/desktop/visibleActionDispatcher.ts')));
  const open = () => {
    runtime = createVisibleActionRuntime(path.join(temp, 'data', 'outbox.sqlite'), path.join(temp, 'data', 'locks'));
    receipts = new DesktopActionIdempotency(path.join(temp, 'data', 'receipts'));
    return new VisibleActionDispatcher(receipts, runtime.coordinator);
  };
  let version = 1, dispatches = 0;
  const context = { sessionId: 'session', taskId: 'task', target: 'window', action: 'click', indicatorEpoch: 1,
    isCurrent: () => version === 1, isIndicatorCurrent: epoch => epoch === version };
  const fingerprint = 'a'.repeat(64);
  const backend = async () => { dispatches++; return { effect: 'unverifiable' }; };
  let dispatcher = open();
  const first = await dispatcher.run(context, 'request-1', fingerprint, backend);
  assert.equal(first.reply.outcome, 'dispatched');
  assert.equal(dispatches, 1);
  assert.doesNotMatch(JSON.stringify(first), /deliveryToken|acknowledge/,
    'the host-only delivery credential must not enter a serialized tool response');
  const replay = await dispatcher.run(context, 'request-1', fingerprint, backend);
  assert.deepEqual(replay.reply, first.reply);
  assert.equal(dispatches, 1, 'the same request ID never dispatches twice');
  await assert.rejects(dispatcher.run(context, 'request-2', 'b'.repeat(64), backend), /not dispatched/,
    'a known but unconfirmed result keeps the task blocked');
  const receiptDb = new DatabaseSync(path.join(temp, 'data', 'receipts', 'action-receipts.sqlite'));
  try {
    const saved = receiptDb.prepare('SELECT result FROM desktop_action_receipts').get().result;
    const tampered = JSON.parse(saved);
    tampered.value.effect = 'confirmed';
    receiptDb.prepare('UPDATE desktop_action_receipts SET result = ?').run(JSON.stringify(tampered));
    await assert.rejects(dispatcher.run(context, 'request-1', fingerprint, backend), /does not match/,
      'a damaged deduplication record must never replace the authoritative result');
    const badToken = JSON.parse(saved); badToken.deliveryToken = 'x'.repeat(43);
    receiptDb.prepare('UPDATE desktop_action_receipts SET result = ?').run(JSON.stringify(badToken));
    await assert.rejects(dispatcher.run(context, 'request-1', fingerprint, backend), /does not match/,
      'the delivery credential must match the authoritative barrier');
    receiptDb.prepare('UPDATE desktop_action_receipts SET result = ?').run(saved);
  } finally { receiptDb.close(); }
  assert.equal(dispatches, 1);
  receipts.close(); runtime.close();
  dispatcher = open();
  const recovered = await dispatcher.run(context, 'request-1', fingerprint, backend);
  assert.deepEqual(recovered.reply, first.reply);
  assert.equal(dispatches, 1, 'restart can recover the receipt without repeating input');
  assert.deepEqual(await recovered.acknowledge('delivery-1'), { outcome: 'acknowledged' });
  assert.deepEqual(await recovered.acknowledge('another-engine-call'), { outcome: 'acknowledged' },
    'the same invocation uses one durable receipt across engine call IDs');
  await assert.rejects(dispatcher.run(context, 'request-1', 'c'.repeat(64), backend), /different operation/);
  const second = await dispatcher.run(context, 'request-2', 'b'.repeat(64), backend);
  assert.equal(second.reply.outcome, 'dispatched'); assert.equal(dispatches, 2);
  version = 2;
  await assert.rejects(second.acknowledge('delivery-2'), /rejected/,
    'a stopped or replaced indicator cannot acknowledge an old result');
  assert.equal(dispatches, 2);
  const other = { ...context, taskId: 'other-task', indicatorEpoch: 2, isCurrent: () => version === 2 };
  let uncertainDispatches = 0;
  const uncertain = async () => { uncertainDispatches++; throw new Error('backend disconnected'); };
  const unknown = await dispatcher.run(other, 'unknown-1', fingerprint, uncertain);
  assert.equal(unknown.reply.outcome, 'unknown');
  assert.equal((await dispatcher.run(other, 'unknown-1', fingerprint, uncertain)).reply.outcome, 'unknown');
  await assert.rejects(dispatcher.run(other, 'unknown-2', 'b'.repeat(64), uncertain), /not dispatched/);
  assert.equal(uncertainDispatches, 1, 'unknown input is never replayed, including with a new request ID');
  console.log('visible action dispatcher: request deduplication, durable delivery barrier and restart passed');
} finally {
  receipts?.close(); runtime?.close(); removeWorkspaceFixture(temp, 'desktop-visible-dispatch-');
}
