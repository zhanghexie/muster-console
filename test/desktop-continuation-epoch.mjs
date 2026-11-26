import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-continuation-'));
let history, waits;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const load = async name => import(pathToFileURL(compile(`main/${name}.ts`)));
  const { SqliteDesktopEpochHistory } = await load('desktop/epochHistory');
  const { SchedulerDesktopTaskEpochs } = await load('desktop/schedulerTaskEpoch');
  const { DesktopTurnEpochGuard } = await load('desktop/turnEpoch');
  const { ResumeWaitStore } = await load('resumeWait/store');
  const { ResumeWaitService } = await load('resumeWait/service');
  history = new SqliteDesktopEpochHistory(path.join(tmp, 'epochs.sqlite'));
  waits = new ResumeWaitStore(path.join(tmp, 'events'));
  let receipt = 0, delivered;
  const epochs = new SchedulerDesktopTaskEpochs(async () => ({ approvalId: `approval-${++receipt}` }), async () => {}, history);
  const service = new ResumeWaitService(waits, { now: Date.now, isBusy: () => true,
    desktopEpoch: owner => epochs.currentBinding(owner) ?? null,
    alert() {},
    async deliver(_wait, _content, _id, batch) { delivered = batch; return { status: 'confirmed' }; } });
  const scope = { appId: 'application', actionClass: 'click' };
  const a = await epochs.ensure('scheduler', scope, () => true);
  const waiting = service.arm('scheduler', 'workspace', { condition: { kind: 'time', at: '2026-01-01T00:00:00Z' }, note: 'continue', priority: 'preempt' });
  assert.equal(waiting.desktopEpoch, a);
  const b = await epochs.startNew('scheduler', scope, () => true);
  await service.tick();
  assert.equal(delivered.length, 1);
  const guard = new DesktopTurnEpochGuard();
  guard.begin('scheduler', 'turn');
  guard.continuation('scheduler', 'turn', delivered.map(wait => ({ waitId: wait.id, epoch: wait.desktopEpoch, generation: wait.desktopEpochGeneration, uncertain: wait.desktopEpochUnknown })), epochs.currentBinding('scheduler'));
  assert.throws(() => guard.assertWrite('scheduler', 'turn', epochs.currentBinding('scheduler'), id => epochs.isCurrent('scheduler', id)),
    error => error.message.includes(waiting.id) && error.message.includes(a) && error.message.includes(b));
  guard.end('scheduler', 'turn');
  guard.begin('scheduler', 'next-turn');
  assert.equal(guard.assertWrite('scheduler', 'next-turn', epochs.currentBinding('scheduler'), id => epochs.isCurrent('scheduler', id)), b);
  console.log('desktop continuation epoch: host approval A, durable wait, mixed B turn and next-turn reset');
} finally {
  waits?.close(); history?.close();
  const resolved = fs.realpathSync(tmp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('desktop-continuation-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
