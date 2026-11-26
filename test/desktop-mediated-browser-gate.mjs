import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-mediation-'));
let audit;
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { MediatedBrowserGate } = await import(pathToFileURL(compile('main/desktop/mediatedBrowserGate.ts')));
  const { DesktopUnknownState } = await import(pathToFileURL(compile('main/desktop/unknownState.ts')));
  const { DesktopAuditStore } = await import(pathToFileURL(compile('main/desktop/auditStore.ts')));
  const { DesktopDispatchJournal } = await import(pathToFileURL(compile('main/desktop/dispatchJournal.ts')));
  const { DesktopTaskLock } = await import(pathToFileURL(compile('main/desktop/taskLock.ts')));
  audit = new DesktopAuditStore(':memory:', () => 1);
  const journal = new DesktopDispatchJournal(path.join(temp, 'journal')), lock = new DesktopTaskLock(path.join(temp, 'lock'));
  let actorCurrent = true, targetCurrent = true, authorized = true, auditFailure = '', dispatches = 0, cleanups = 0;
  const actor = { sessionId: 'session', taskId: 'task', isCurrent: () => actorCurrent };
  const target = { identity: 'tab-identity', isCurrent: () => targetCurrent };
  let planSeen, resolveStarted, finishResolve;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  let waitResolve = true;
  const makeGate = () => new MediatedBrowserGate(async (_actor, plan) => {
    planSeen = plan;
    if (waitResolve) { resolveStarted(); await new Promise(resolve => { finishResolve = resolve; }); }
    return target;
  }, async () => () => authorized, async ({ actor: who, target: view, action, stage, result, resolution }) => {
    if (auditFailure === stage) throw new Error('audit failure');
    audit.append({ sessionId: who.sessionId, taskId: who.taskId, source: 'browser', action, stage, result, surfaceId: view.identity, ...(resolution ? { resolution } : {}) });
  }, journal, lock, new DesktopUnknownState());
  let gate = makeGate();
  const args = { tabId: 'tab-1', nested: { value: 'original' } };
  let dispatchedArgs;
  const pending = gate.run(actor, 'browser.click', args, async snapshot => { dispatches++; dispatchedArgs = snapshot; return 'ok'; });
  await started; args.nested.value = 'changed'; finishResolve();
  assert.deepEqual(await pending, { outcome: 'completed', value: 'ok' });
  assert.equal(dispatchedArgs.nested.value, 'original'); assert.equal(Object.isFrozen(dispatchedArgs.nested), true);
  assert.equal(planSeen.unknownEffect, true);
  waitResolve = false;
  await gate.run(actor, 'browser.evaluate', { tabId: 'tab-1', expression: 'private text' }, async () => 'ok');
  assert.deepEqual([planSeen.contentRead, planSeen.pixelRead, planSeen.unknownEffect], [true, true, true]);
  assert.doesNotMatch(JSON.stringify(audit.list('session')), /private text|tab-1/);
  const before = dispatches;
  authorized = false;
  await assert.rejects(gate.run(actor, 'browser.click', { tabId: 'tab-1' }, async () => ++dispatches), /authorization/);
  assert.equal(dispatches, before);
  authorized = true; targetCurrent = false;
  await assert.rejects(gate.run(actor, 'browser.click', { tabId: 'tab-1' }, async () => ++dispatches), /target changed/);
  targetCurrent = true; auditFailure = 'dispatch-intent';
  await assert.rejects(gate.run(actor, 'browser.click', { tabId: 'tab-1' }, async () => ++dispatches), /audit failure/);
  assert.equal(dispatches, before);
  auditFailure = '';
  assert.deepEqual(await gate.run(actor, 'browser.click', { tabId: 'tab-1' }, async () => { throw new Error('unknown side effect'); }), { outcome: 'unknown' });
  const pendingMarker = await journal.read('task'); assert.ok(pendingMarker);
  await assert.rejects(gate.run(actor, 'browser.click', { tabId: 'tab-1' }, async () => ++dispatches), /reconcile/);
  assert.deepEqual(await gate.run(actor, 'browser.snapshot', { tabId: 'tab-1' }, async () => 'readback'), { outcome: 'completed', value: 'readback' });
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await gate.run(actor, 'browser.recording', { action: 'cancel' }, async () => 'must not run', async () => { cleanups++; }, aborted.signal),
    { outcome: 'cleaned', disclosed: false });
  await assert.rejects(gate.reconcile(actor, async () => undefined), /not confirmed/);
  auditFailure = 'reconciliation';
  await assert.rejects(gate.reconcile(actor, async () => 'confirmed-not-applied'), /audit failure/);
  assert.equal((await journal.read('task')).id, pendingMarker.id, 'audit failure cannot clear an unknown result');
  auditFailure = '';
  assert.equal(await gate.reconcile(actor, async pending => { assert.equal(pending.id, pendingMarker.id); return 'confirmed-not-applied'; }), 'confirmed-not-applied');
  assert.equal(await journal.read('task'), null);
  assert.equal(audit.list('session').at(-1).resolution, 'confirmed-not-applied');
  assert.deepEqual(await gate.run(actor, 'browser.click', { tabId: 'tab-1' }, async () => { authorized = false; return 'secret'; }), { outcome: 'unknown' });
  const secondMarker = await journal.read('task'); assert.ok(secondMarker);
  await gate.reconcile(actor, async () => 'confirmed-applied');
  authorized = true;
  authorized = false;
  await assert.rejects(gate.run(actor, 'browser.recording', { action: 'stop' }, async () => 'private recording', async () => { cleanups++; }), /authorization/);
  assert.equal(cleanups, 2, 'denied output still stops and discards its recording');
  authorized = true; auditFailure = 'dispatch-intent';
  await assert.rejects(gate.run(actor, 'browser.recording', { action: 'stop' }, async () => 'private recording', async () => { cleanups++; }), /audit failure/);
  assert.equal(cleanups, 3, 'audit failure cannot leave an owned recording running');
  auditFailure = '';
  assert.deepEqual(await gate.run(actor, 'browser.recording', { action: 'stop' }, async () => { throw new Error('unknown'); }, async () => { cleanups++; }),
    { outcome: 'unknown', cleanup: 'completed' });
  const recordingMarker = await journal.read('task'); assert.ok(recordingMarker);
  await assert.rejects(gate.run(actor, 'browser.recording', { action: 'stop' }, async () => 'never', async () => { cleanups++; }), /reconcile/);
  await gate.reconcile(actor, async () => 'abandoned');
  assert.deepEqual(await gate.run(actor, 'browser.recording', { action: 'stop' }, async () => { throw new Error('unknown'); }, async () => { throw new Error('cleanup failed'); }),
    { outcome: 'unknown', cleanup: 'failed' });
  await assert.rejects(gate.run(actor, 'browser.recording', { action: 'start' }, async () => 'never'), /cleanup is required/);
  await assert.rejects(gate.run(actor, 'browser.recording', { action: 'cancel' }, async () => 'never'), /cleanup is required/);
  const otherActor = { ...actor, taskId: 'other-task' };
  const externalMarker = await journal.begin('other-task', { appId: 'native-app', surfaceId: 'window', action: 'click' });
  await assert.rejects(gate.run(otherActor, 'browser.click', {}, async () => 'never'), /reconcile/);
  await assert.rejects(gate.reconcile(otherActor, async () => 'abandoned'), /another desktop surface/);
  assert.equal((await journal.read('other-task')).id, externalMarker.id, 'browser cannot clear another surface pending record');
  await journal.finish('other-task', externalMarker.id);
  auditFailure = 'dispatch-result';
  assert.deepEqual(await gate.run(otherActor, 'browser.click', {}, async () => 'effect happened'), { outcome: 'unknown', audit: 'failed' });
  const unavailableAuditMarker = await journal.read('other-task'); assert.ok(unavailableAuditMarker);
  await assert.rejects(gate.run(otherActor, 'browser.recording', { action: 'cancel' }, async () => 'never', async () => { cleanups++; }), /cleanup completed but audit failed/);
  auditFailure = '';
  await gate.reconcile(otherActor, async () => 'confirmed-applied');
  let enteredLock, releaseLock;
  const lockEntered = new Promise(resolve => { enteredLock = resolve; });
  const held = lock.run('other-task', async () => { enteredLock(); await new Promise(resolve => { releaseLock = resolve; }); });
  await lockEntered;
  const beforeCleanup = cleanups;
  await assert.rejects(gate.run(otherActor, 'browser.recording', { action: 'stop' }, async () => 'never', async () => { cleanups++; }), /locked/);
  assert.equal(cleanups, beforeCleanup + 1, 'coordination failure still cleans an owned recording');
  releaseLock(); await held;
  const releaseFailureActor = { ...actor, taskId: 'release-failure' };
  let releaseCleanups = 0;
  const failingLock = { run: async (_task, fn) => { await fn(); throw new Error('lock release failed'); } };
  const releaseFailureGate = new MediatedBrowserGate(async () => target, async () => () => true,
    async () => {}, journal, failingLock, new DesktopUnknownState());
  assert.deepEqual(await releaseFailureGate.run(releaseFailureActor, 'browser.recording', { action: 'stop' },
    async () => 'private recording', async () => { releaseCleanups++; }), { outcome: 'unknown', cleanup: 'completed' });
  assert.ok(await journal.read('release-failure'), 'release failure must leave a durable pending marker');
  await assert.rejects(gate.run(releaseFailureActor, 'browser.click', {}, async () => 'never'), /reconcile/,
    'a separate coordinator is blocked by the durable marker');
  assert.equal(releaseCleanups, 1, 'lock release failure discards undisclosed output');
  await assert.rejects(releaseFailureGate.run(releaseFailureActor, 'browser.click', {}, async () => 'never'), /reconcile/);
  await assert.rejects(releaseFailureGate.reconcile(releaseFailureActor, async () => 'abandoned'), /lock release failed/);
  const finishActor = { ...actor, taskId: 'finish-failure' };
  const originalFinish = journal.finish.bind(journal);
  journal.finish = async () => { throw Error('finish failed'); };
  assert.deepEqual(await gate.run(finishActor, 'browser.recording', { action: 'stop' }, async () => 'private', async () => { cleanups++; }),
    { outcome: 'unknown', cleanup: 'completed' });
  assert.ok(await journal.read('finish-failure'));
  journal.finish = originalFinish;
  await gate.reconcile(finishActor, async () => 'abandoned');
  let afterReleaseCurrent = true;
  const changingTarget = { identity: 'changing-tab', isCurrent: () => afterReleaseCurrent };
  const changingLock = { run: async (_task, operation) => { const value = await operation(); afterReleaseCurrent = false; return value; } };
  const changingGate = new MediatedBrowserGate(async () => changingTarget, async () => () => true, async () => {}, journal, changingLock, new DesktopUnknownState());
  const changingActor = { ...actor, taskId: 'changed-after-release' };
  assert.deepEqual(await changingGate.run(changingActor, 'browser.click', {}, async () => 'private'), { outcome: 'unknown' });
  assert.ok(await journal.read('changed-after-release'), 'target change during release must retain pending marker');
  let finalizationCurrent = true;
  const finishChangingGate = new MediatedBrowserGate(async () => ({ identity: 'tab', isCurrent: () => finalizationCurrent }),
    async () => () => true, async () => {}, journal, lock, new DesktopUnknownState());
  const finalizationActor = { ...actor, taskId: 'changed-during-finalization' };
  journal.finish = async (...args) => { await originalFinish(...args); finalizationCurrent = false; };
  assert.deepEqual(await finishChangingGate.run(finalizationActor, 'browser.click', {}, async () => 'private'), { outcome: 'unknown' });
  journal.finish = originalFinish;
  await assert.rejects(finishChangingGate.run(finalizationActor, 'browser.click', {}, async () => 'never'), /reconcile/);
  await assert.rejects(gate.run(actor, 'browser.future', {}, async () => 'never'), /Unclassified/);
  await assert.rejects(gate.run(actor, 'browser.click', { n: NaN }, async () => 'never'), /Invalid/);
  actorCurrent = false;
  await assert.rejects(gate.run(actor, 'browser.click', {}, async () => 'never'), /caller changed/);
  console.log('browser mediation gate: scoped proofs, private audit, unknown outcomes and recording cleanup passed');
} finally {
  audit?.close();
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('browser-mediation-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
