import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-action-gate-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActionGate } = await import(pathToFileURL(compile('main/desktop/actionGate.ts')));
  const { DesktopAuthority } = await import(pathToFileURL(compile('main/desktop/authority.ts')));
  const { DesktopUnknownState } = await import(pathToFileURL(compile('main/desktop/unknownState.ts')));
  const { DesktopDispatchJournal } = await import(pathToFileURL(compile('main/desktop/dispatchJournal.ts')));
  const { UnknownActionChains } = await import(pathToFileURL(compile('main/desktop/unknownActionChain.ts')));
  const { DesktopTaskLock } = await import(pathToFileURL(compile('main/desktop/taskLock.ts')));
  const lock = new DesktopTaskLock(path.join(temp, 'locks'));
  const journal = new DesktopDispatchJournal(path.join(temp, 'journal'));
  let appApprovals = 0, objectApprovals = 0, chainApprovals = 0, dispatches = 0;
  const auditEvents = [];
  const authority = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal,
    confirmApplication: async () => { appApprovals++; return true; }, confirmObject: async () => { objectApprovals++; return true; }, audit: async () => {} });
  const chains = new UnknownActionChains(journal);
  let evidenceCurrent = true, evidenceChecks = 0;
  const verifyEvidence = async () => { evidenceChecks++; if (!evidenceCurrent) throw new Error('evidence invalid'); return () => evidenceCurrent; };
  const verified = async () => () => true;
  const gate = new DesktopActionGate(authority, chains, async (_boundary, signal) => {
    assert.equal(signal.aborted, false); chainApprovals++; return true;
  }, async (boundary, decision) => { auditEvents.push([boundary.evidenceSha256, decision]); }, lock, verifyEvidence);
  const request = { taskId: 'task', target: { appId: 'app', processInstance: 'p1', surfaceId: 'w1', surfaceGeneration: 'g1' }, action: 'click', foreground: true };
  const boundary = { taskId: 'task', appId: 'app', processInstance: 'p1', surfaceId: 'w1', surfaceGeneration: 'g1',
    captureId: 'capture', geometryRevision: 'geometry', region: { x: 0, y: 0, width: 10, height: 10 }, actionClass: 'input', evidenceSha256: 'a'.repeat(64) };
  const run = (value = request, evidence = boundary) => gate.runUnknown(value, evidence, () => true, async () => ++dispatches);
  assert.equal((await run()).outcome, 'dispatched');
  assert.equal((await run()).outcome, 'dispatched');
  assert.equal(chainApprovals, 1); assert.equal(appApprovals, 1); assert.equal(dispatches, 2);
  assert.equal(evidenceChecks, 2, 'every action verifies its own evidence even when approval is reused');
  evidenceCurrent = false;
  await assert.rejects(run(), /evidence invalid/);
  assert.equal(dispatches, 2); evidenceCurrent = true;
  assert.throws(() => new DesktopActionGate(authority, chains, async () => true, async () => {}, lock), /evidence verifier/);
  let proofCurrent = true, staleDispatches = 0;
  const proofJournal = new DesktopDispatchJournal(path.join(temp, 'proof-race'));
  const proofGate = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal: proofJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(proofJournal), async () => { proofCurrent = false; return true; }, async () => {}, lock,
  async () => () => proofCurrent);
  await assert.rejects(proofGate.runUnknown(request, boundary, () => true, async () => ++staleDispatches), /invalidated/);
  assert.equal(staleDispatches, 0, 'expired evidence after confirmation must prevent dispatch');
  const invalidProofGate = new DesktopActionGate(authority, new UnknownActionChains(journal), async () => true, async () => {}, lock,
    async () => () => 'not a boolean');
  await assert.rejects(invalidProofGate.runUnknown(request, boundary, () => true, async () => ++staleDispatches), /no longer current/);
  assert.equal(staleDispatches, 0, 'truthy non-boolean evidence proofs are rejected');
  assert.equal(auditEvents.filter(([, decision]) => decision === 'attempt').length, 2);
  const known = { ...request, effect: { kind: 'irreversible', objectFingerprint: 'b'.repeat(64) } };
  await gate.runKnown(known, () => true, async () => 'known');
  await gate.runKnown(known, () => true, async () => 'known');
  assert.equal(objectApprovals, 1); assert.equal(chainApprovals, 1);
  await assert.rejects(gate.runKnown({ ...request, effect: { kind: 'unknown' } }, () => true, async () => 'unsafe'), /Invalid/);
  gate.takeover('task');
  await run(); assert.equal(chainApprovals, 2);
  const other = { ...request, target: { ...request.target, appId: 'other', processInstance: 'p2' } };
  await run(other, { ...boundary, appId: 'other', processInstance: 'p2' });
  await run(); assert.equal(chainApprovals, 4, 'returning to an old app requires a new chain');
  await assert.rejects(run(request, { ...boundary, appId: 'spoof' }), /does not match/);
  await assert.rejects(run(request, { ...boundary, surfaceGeneration: 'other-generation' }), /does not match/);
  await assert.rejects(run(request, { ...boundary, processInstance: 'other-process' }), /does not match/);
  let firstStarted, finishFirst, serializedApprovals = 0;
  const firstEntered = new Promise(resolve => { firstStarted = resolve; });
  const serializedJournal = new DesktopDispatchJournal(path.join(temp, 'serialized'));
  const serialized = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal: serializedJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(serializedJournal), async () => { serializedApprovals++; return true; }, async () => {}, lock, verified);
  const first = serialized.runUnknown(request, boundary, () => true, async () => {
    firstStarted(); return new Promise(resolve => { finishFirst = resolve; });
  });
  await firstEntered;
  let competingPrompts = 0;
  const competing = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal: serializedJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(serializedJournal), async () => { competingPrompts++; return true; }, async () => {}, lock, verified);
  await assert.rejects(competing.runUnknown(other, { ...boundary, appId: 'other', processInstance: 'p2' }, () => true, async () => 'unsafe'), /locked by another/);
  assert.equal(competingPrompts, 0, 'another coordinator cannot even request approval while the task is locked');
  const second = serialized.runUnknown(other, { ...boundary, appId: 'other', processInstance: 'p2' }, () => true, async () => 'second');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(serializedApprovals, 1, 'another app does not replace approval while input is in flight');
  finishFirst('first');
  assert.deepEqual(await first, { outcome: 'dispatched', value: 'first' });
  assert.deepEqual(await second, { outcome: 'dispatched', value: 'second' });
  assert.equal(serializedApprovals, 2);
  let inputStarted, finishInput, uncertainPrompts = 0;
  const inputEntered = new Promise(resolve => { inputStarted = resolve; });
  const uncertainJournal = new DesktopDispatchJournal(path.join(temp, 'uncertain'));
  const uncertainGate = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal: uncertainJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(uncertainJournal), async () => { uncertainPrompts++; return true; }, async () => {}, lock, verified);
  const uncertain = uncertainGate.runUnknown(request, boundary, () => true, signal => new Promise(resolve => {
    inputStarted(); finishInput = () => { assert.equal(signal.aborted, true); resolve('may have taken effect'); };
  }));
  await inputEntered;
  uncertainGate.takeover('task'); finishInput();
  assert.deepEqual(await uncertain, { outcome: 'unknown' });
  await assert.rejects(uncertainGate.runUnknown(request, boundary, () => true, async () => 'must not retry'), /reconcile/);
  assert.equal(uncertainPrompts, 1, 'unknown prior outcome blocks before another prompt');
  const auditJournal = new DesktopDispatchJournal(path.join(temp, 'audit-failure'));
  let failAttempt = true, auditedDispatches = 0;
  const auditGate = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal: auditJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(auditJournal), async () => true, async (_item, decision) => {
    if (decision === 'attempt' && failAttempt) throw new Error('audit unavailable');
  }, lock, verified);
  await assert.rejects(auditGate.runUnknown(request, boundary, () => true, async () => ++auditedDispatches), /audit unavailable/);
  assert.equal(auditedDispatches, 0);
  failAttempt = false;
  await auditGate.runUnknown(request, boundary, () => true, async () => ++auditedDispatches);
  assert.equal(auditedDispatches, 1);
  const releaseFailureJournal = new DesktopDispatchJournal(path.join(temp, 'release-failure'));
  let failRelease = true, releaseFailureDispatches = 0;
  const brokenLock = { run: async (_task, operation) => { const value = await operation(); if (failRelease) { failRelease = false; throw new Error('release failed'); } return value; } };
  const releaseFailure = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal: releaseFailureJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(releaseFailureJournal), async () => true, async () => {}, brokenLock, verified);
  assert.deepEqual(await releaseFailure.runUnknown(request, boundary, () => true, async () => { releaseFailureDispatches++; return 'may-have-happened'; }),
    { outcome: 'unknown', reason: 'coordinator-release-failed' });
  assert.ok(await releaseFailureJournal.read('task'), 'release failure must leave a durable pending marker');
  const restartedAuthority = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal: releaseFailureJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} });
  await assert.rejects(restartedAuthority.assertTaskAvailable('task'), /reconcile/, 'the pending marker also blocks after restart');
  await assert.rejects(releaseFailure.runUnknown(request, boundary, () => true, async () => ++releaseFailureDispatches), /reconcile/);
  assert.equal(releaseFailureDispatches, 1, 'coordinator failure must prevent replay even if the lock was released');
  const finishJournal = new DesktopDispatchJournal(path.join(temp, 'finish-failure'));
  const finish = finishJournal.finish.bind(finishJournal);
  finishJournal.finish = async () => { throw Error('finish failed'); };
  const finishGate = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal: finishJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(finishJournal), async () => true, async () => {}, lock, verified);
  assert.equal((await finishGate.runUnknown(request, boundary, () => true, async () => 'possibly applied')).outcome, 'unknown');
  assert.ok(await finishJournal.read('task'), 'failed finalization retains its pending marker');
  finishJournal.finish = finish;
  let afterReleaseCurrent = true;
  const changingLock = { run: async (_task, operation) => { const value = await operation(); afterReleaseCurrent = false; return value; } };
  const changingJournal = new DesktopDispatchJournal(path.join(temp, 'changed-after-release'));
  const changingGate = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal: changingJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(changingJournal), async () => true, async () => {}, changingLock, verified);
  assert.equal((await changingGate.runKnown({ ...request, effect: { kind: 'reversible' } }, () => afterReleaseCurrent, async () => 'private')).outcome, 'unknown');
  assert.ok(await changingJournal.read('task'), 'target change during release must retain pending marker');
  let releaseClock = 0;
  const expiryLock = { run: async (_task, operation) => { const value = await operation(); releaseClock = 100; return value; } };
  const expiryJournal = new DesktopDispatchJournal(path.join(temp, 'expiry-after-release'));
  const expiryGate = new DesktopActionGate(new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, now: () => releaseClock, journal: expiryJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }),
  new UnknownActionChains(expiryJournal), async () => true, async () => {}, expiryLock, verified);
  assert.equal((await expiryGate.runKnown({ ...request, effect: { kind: 'reversible' } }, () => true, async () => 'private')).outcome, 'unknown');
  assert.ok(await expiryJournal.read('task'), 'authorization expiring during release retains the pending marker');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const blockedAuthority = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000,
    journal: new DesktopDispatchJournal(path.join(temp, 'race')),
    confirmApplication: async () => { entered(); return new Promise(resolve => { release = resolve; }); },
    confirmObject: async () => true, audit: async () => {} });
  const race = new DesktopActionGate(blockedAuthority, new UnknownActionChains(new DesktopDispatchJournal(path.join(temp, 'race-chain'))),
    async () => true, async () => {}, lock, verified);
  const pending = race.runUnknown(request, boundary, () => true, async () => ++dispatches);
  await started;
  race.takeover('task');
  release(true);
  await assert.rejects(pending, /abort|changed/i);
  assert.equal(dispatches, 5, 'takeover while approval is in flight prevents dispatch');
  gate.endTask('task');
  await assert.rejects(run(), /ended/);
  assert.equal(chainApprovals, 4, 'ended tasks do not prompt again');
  console.log('desktop action gate: chain, audit, app grant and takeover race passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
