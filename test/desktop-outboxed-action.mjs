import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-outboxed-'));
let outbox;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = async name => import(pathToFileURL(compile(`main/desktop/${name}.ts`)));
  const { WriteOutbox } = await load('writeOutbox');
  const { OutboxedDesktopAction } = await load('outboxedAction');
  const { DesktopActionGate } = await load('actionGate');
  const { DesktopAuthority } = await load('authority');
  const { DesktopUnknownState } = await load('unknownState');
  const { DesktopDispatchJournal } = await load('dispatchJournal');
  const { DesktopTaskLock } = await load('taskLock');
  const { UnknownActionChains } = await load('unknownActionChain');
  const { DesktopTurnEpochGuard } = await load('turnEpoch');
  const journal = new DesktopDispatchJournal(path.join(temp, 'journal'));
  const authority = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} });
  const gate = new DesktopActionGate(authority, new UnknownActionChains(journal), async () => true, async () => {},
    new DesktopTaskLock(path.join(temp, 'lock')), async () => () => true);
  const file = path.join(temp, 'outbox.sqlite');
  outbox = new WriteOutbox(file);
  let rejectEpoch = false, turnGuard;
  const assertEpoch = (sessionId, taskId) => {
    if (rejectEpoch) throw Error('epoch conflict wait-A vs approval-B');
    if (turnGuard) {
      const active = { epoch: taskId, generation: 0, anchor: 'approval-B' };
      if (turnGuard.assertWrite(sessionId, 'turn', active, () => true) !== taskId) throw Error('task mismatch');
    }
  };
  const service = new OutboxedDesktopAction(gate, outbox, assertEpoch);
  const request = { taskId: 'task', target: { appId: 'app', processInstance: 'pid', surfaceId: 'window', surfaceGeneration: 'generation' },
    action: 'click', foreground: false, effect: { kind: 'reversible' } };
  let calls = 0;
  rejectEpoch = true;
  await assert.rejects(service.runKnown('session', request, () => true, async () => ++calls), /epoch conflict/);
  assert.equal(await journal.read('task'), null);
  assert.equal(calls, 0);
  rejectEpoch = false;
  turnGuard = new DesktopTurnEpochGuard();
  turnGuard.begin('session', 'turn');
  turnGuard.continuation('session', 'turn', [{ waitId: 'wait-A', epoch: 'A', generation: 0, uncertain: false }], { epoch: 'task', generation: 0, anchor: 'approval-B' });
  await assert.rejects(service.runKnown('session', request, () => true, async () => ++calls), /wait-A.*approval-B/);
  assert.equal(await journal.read('task'), null);
  assert.equal(calls, 0);
  turnGuard.end('session', 'turn'); turnGuard = undefined;
  const first = await service.runKnown('session', request, () => true, async () => ({ calls: ++calls }));
  assert.equal(first.outcome, 'dispatched');
  assert.equal(calls, 1);
  assert.deepEqual(outbox.get('session', first.invocationId).result, { outcome: 'known', value: { calls: 1 } });
  await assert.rejects(service.runKnown('session', request, () => true, async () => ++calls), /delivery or reconciliation/);
  assert.equal(await journal.read('task'), null, 'blocked preflight must not create a false unknown dispatch');
  assert.equal(calls, 1);
  outbox.close(); outbox = new WriteOutbox(file);
  assert.equal(outbox.recover('session').length, 1, 'unacknowledged result survives restart');
  assert.throws(() => outbox.markDispatched('session', first.invocationId), /state/i);
  outbox.acknowledge('session', first.invocationId, 'receipt');
  const secondService = new OutboxedDesktopAction(gate, outbox, assertEpoch);
  const second = await secondService.runKnown('session', request, () => true, async () => { calls++; throw Error('ambiguous'); });
  assert.equal(second.outcome, 'unknown');
  assert.equal(calls, 2);
  assert.deepEqual(outbox.get('session', second.invocationId).result, { outcome: 'unknown' });
  assert.equal(outbox.isTaskBlocked('session', request.taskId), true);
  let current = true;
  const originalMark = outbox.markDispatched.bind(outbox);
  outbox.markDispatched = (...args) => { originalMark(...args); current = false; };
  const invalidated = await secondService.runKnown('session', { ...request, taskId: 'new-task' }, () => current,
    async () => { calls++; return true; });
  assert.equal(invalidated.outcome, 'unknown');
  assert.equal(calls, 2, 'authorization invalidated during persistence must prevent dispatch');
  assert.deepEqual(outbox.get('session', invalidated.invocationId).result, { outcome: 'unknown' });
  outbox.markDispatched = originalMark;
  let validDuringResult = true;
  const originalComplete = outbox.complete.bind(outbox);
  outbox.complete = (...args) => { originalComplete(...args); validDuringResult = false; };
  const lost = await secondService.runKnown('session', { ...request, taskId: 'result-task' }, () => validDuringResult,
    async () => ({ calls: ++calls }));
  assert.equal(lost.outcome, 'unknown', 'result must not be disclosed after authorization expires');
  assert.equal(outbox.isTaskBlocked('session', 'result-task'), true, 'unacknowledged result blocks the next write');
  assert.deepEqual(outbox.get('session', lost.invocationId).result, { outcome: 'known', value: { calls: 3 } });
  outbox.complete = (...args) => { originalComplete(...args); gate.takeover('takeover-task'); };
  const takeover = await secondService.runKnown('session', { ...request, taskId: 'takeover-task' }, () => true,
    async () => ({ calls: ++calls }));
  assert.equal(takeover.outcome, 'unknown', 'takeover during durable result write suppresses disclosure');
  assert.equal(outbox.isTaskBlocked('session', 'takeover-task'), true);
  outbox.complete = originalComplete;
  const unsupported = await secondService.runKnown('session', { ...request, taskId: 'unsupported-result' }, () => true,
    async () => new Date());
  assert.equal(unsupported.outcome, 'unknown');
  assert.equal(unsupported.persistence, 'failed');
  assert.equal(outbox.get('session', unsupported.invocationId).state, 'dispatched');
  assert.equal(outbox.isTaskBlocked('session', 'unsupported-result'), true, 'lossy result cannot be disclosed or replayed');
  console.log('outboxed desktop action: approval gate, durable result and unknown write block');
} finally {
  outbox?.close();
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('desktop-outboxed-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
