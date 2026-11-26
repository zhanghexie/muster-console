import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-authority-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopAuthority } = await import(pathToFileURL(compile('main/desktop/authority.ts')));
  const { DesktopUnknownState } = await import(pathToFileURL(compile('main/desktop/unknownState.ts')));
  const { DesktopDispatchJournal } = await import(pathToFileURL(compile('main/desktop/dispatchJournal.ts')));
  const journal = new DesktopDispatchJournal(path.join(temp, 'journal'));
  let now = 100, applications = 0, objects = 0, dispatched = 0, failAudit = false;
  const events = [], actions = ['click', 'type'];
  const gate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions, grantTtlMs: 100, now: () => now, journal,
    confirmApplication: async () => { applications++; return true; },
    confirmObject: async () => { objects++; return true; },
    audit: async event => { events.push(event); if (failAudit) throw new Error('audit unavailable'); } });
  const request = { taskId: 'task', target: { appId: 'app', processInstance: 'pid', surfaceId: 'window', surfaceGeneration: 'gen' },
    action: 'click', foreground: true, effect: { kind: 'reversible' } };
  let expiryClock = 0, expiryDispatches = 0;
  const expiryJournal = new DesktopDispatchJournal(path.join(temp, 'expiry'));
  const begin = expiryJournal.begin.bind(expiryJournal);
  expiryJournal.begin = async (...args) => { const marker = await begin(...args); expiryClock = 100; return marker; };
  const expiryGate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, now: () => expiryClock, journal: expiryJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} });
  await assert.rejects(expiryGate.run(request, () => true, async () => ++expiryDispatches), /authorization expired/);
  assert.equal(await expiryJournal.read('task'), null, 'pre-dispatch expiry clears its journal');
  assert.equal(expiryDispatches, 0, 'a grant expiring while the dispatch marker is written must never dispatch');
  assert.throws(() => new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 86400001, journal: expiryJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} }), /Invalid/);
  const perform = () => gate.run(request, () => true, async () => ++dispatched);
  const results = await Promise.all([perform(), perform()]);
  assert.deepEqual(results.map(x => x.outcome), ['dispatched', 'dispatched']);
  assert.equal(applications, 1); assert.equal(dispatched, 2);
  actions.push('dangerous');
  await assert.rejects(gate.run({ ...request, action: 'dangerous' }, () => true, async () => {}), /Invalid/);
  const fingerprint = 'a'.repeat(64), otherFingerprint = 'b'.repeat(64);
  const irreversible = { ...request, effect: { kind: 'irreversible', objectFingerprint: fingerprint } };
  await gate.run(irreversible, () => true, async () => ++dispatched);
  await gate.run(irreversible, () => true, async () => ++dispatched);
  assert.equal(objects, 1);
  await gate.run({ ...irreversible, action: 'type' }, () => true, async () => ++dispatched);
  await gate.run({ ...irreversible, effect: { kind: 'irreversible', objectFingerprint: otherFingerprint } }, () => true, async () => ++dispatched);
  assert.equal(objects, 3);
  assert.deepEqual(events.filter(event => event.stage === 'object-approval').map(event => event.objectFingerprint), [fingerprint, fingerprint, otherFingerprint]);
  await assert.rejects(gate.run({ ...irreversible, effect: { kind: 'irreversible', objectFingerprint: 'sensitive raw recipient' } }, () => true, async () => {}), /Invalid/);
  now = 200; await perform(); assert.equal(applications, 2);
  await gate.run(irreversible, () => true, async () => ++dispatched); assert.equal(objects, 4);
  failAudit = true;
  const before = dispatched;
  await assert.rejects(perform(), /audit unavailable/);
  assert.equal(dispatched, before);
  failAudit = false;
  assert.deepEqual(await gate.run(request, () => true, async () => { throw new Error('lost response'); }), { outcome: 'unknown' });
  await assert.rejects(perform(), /reconcile/);
  failAudit = true; await assert.rejects(gate.resolveUnknown('task', 'confirmed-not-applied'), /audit unavailable/); failAudit = false;
  await assert.rejects(perform(), /reconcile/);
  await gate.resolveUnknown('task', 'confirmed-not-applied');
  const aborted = new AbortController();
  const interrupted = await gate.run(request, () => true, async signal => { assert.equal(signal, aborted.signal); aborted.abort(); return 'possibly effected'; }, aborted.signal);
  assert.deepEqual(interrupted, { outcome: 'unknown' });
  await gate.resolveUnknown('task', 'confirmed-applied');
  const auditLost = await gate.run(request, () => true, async () => { failAudit = true; return 'possibly effected'; });
  assert.deepEqual(auditLost, { outcome: 'unknown' }); failAudit = false;
  await gate.resolveUnknown('task', 'abandoned');
  let appAsked = 0, allowApp = false;
  const deniedGate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal,
    confirmApplication: async () => { appAsked++; return allowApp; }, confirmObject: async () => { throw new Error('should not ask'); }, audit: async () => {} });
  await assert.rejects(deniedGate.run(request, () => true, async () => ++dispatched), /declined/);
  await assert.rejects(deniedGate.run(request, () => true, async () => ++dispatched), /previously declined/);
  assert.equal(appAsked, 1);
  const restartedDenial = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal,
    confirmApplication: async () => { appAsked++; return true; }, confirmObject: async () => true, audit: async () => {} });
  await assert.rejects(restartedDenial.run(request, () => true, async () => ++dispatched), /previously declined/);
  assert.equal(appAsked, 1);
  let turnAllowed = true;
  const turnGate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal,
    turnGranted: () => turnAllowed, confirmApplication: async () => { throw new Error('unexpected app prompt'); },
    confirmObject: async () => true, audit: async () => {} });
  assert.equal((await turnGate.run(request, () => true, async () => 'ok')).outcome, 'dispatched');
  turnAllowed = false;
  await assert.rejects(turnGate.run(request, () => true, async () => 'wrong'), /previously declined/);
  await deniedGate.clearRefusalAfterUserRequest(request); allowApp = true;
  assert.equal((await deniedGate.run(request, () => true, async () => 'ok')).outcome, 'dispatched');
  let deniedAuditCalls = 0;
  const deniedWithAuditFailure = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal: new DesktopDispatchJournal(path.join(temp, 'denied-audit')),
    confirmApplication: async () => { deniedAuditCalls++; return false; }, confirmObject: async () => true,
    audit: async () => { throw new Error('audit unavailable'); } });
  await assert.rejects(deniedWithAuditFailure.run(request, () => true, async () => ++dispatched), /audit unavailable/);
  await assert.rejects(deniedWithAuditFailure.run(request, () => true, async () => ++dispatched), /previously declined/);
  assert.equal(deniedAuditCalls, 1);
  const sharedJournal = new DesktopDispatchJournal(path.join(temp, 'shared-refusal'));
  const cachedGate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal: sharedJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} });
  const otherGate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal: sharedJournal,
    confirmApplication: async () => false, confirmObject: async () => true, audit: async () => {} });
  await cachedGate.run(request, () => true, async () => 'ok');
  await assert.rejects(otherGate.run(request, () => true, async () => ++dispatched), /declined/);
  await assert.rejects(cachedGate.run(request, () => true, async () => ++dispatched), /previously declined/);
  const sharedObjectJournal = new DesktopDispatchJournal(path.join(temp, 'shared-object-refusal'));
  const cachedObjectGate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal: sharedObjectJournal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} });
  const otherObjectGate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal: sharedObjectJournal,
    confirmApplication: async () => true, confirmObject: async () => false, audit: async () => {} });
  await cachedObjectGate.run(irreversible, () => true, async () => 'ok');
  await assert.rejects(otherObjectGate.run(irreversible, () => true, async () => ++dispatched), /declined/);
  await assert.rejects(cachedObjectGate.run(irreversible, () => true, async () => ++dispatched), /previously declined/);
  let objectAsked = 0, allowObject = false;
  const objectDenied = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal,
    confirmApplication: async () => true, confirmObject: async () => { objectAsked++; return allowObject; }, audit: async () => {} });
  await assert.rejects(objectDenied.run(irreversible, () => true, async () => ++dispatched), /declined/);
  await assert.rejects(objectDenied.run(irreversible, () => true, async () => ++dispatched), /previously declined/);
  assert.equal(objectAsked, 1);
  await objectDenied.clearRefusalAfterUserRequest(irreversible); allowObject = true;
  assert.equal((await objectDenied.run(irreversible, () => true, async () => 'ok')).outcome, 'dispatched');
  gate.revokeTask('task');
  await assert.rejects(perform(), /changed/);
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const approval = new Promise(resolve => { finish = resolve; });
  const pendingGate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal,
    confirmApplication: async () => { entered(); return approval; }, confirmObject: async () => true, audit: async () => {} });
  const pending = pendingGate.run({ ...request, taskId: 'pending' }, () => true, async () => ++dispatched);
  await started; pendingGate.revokeTask('pending'); finish(true);
  await assert.rejects(pending, /changed/);
  assert.equal(dispatched, before);
  let rejectDispatch, signalStarted;
  const running = new Promise(resolve => { signalStarted = resolve; });
  const anotherGate = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} });
  const uncertain = anotherGate.run(request, () => true, async () => {
    signalStarted(); return await new Promise((_resolve, reject) => { rejectDispatch = reject; });
  });
  await running;
  await assert.rejects(anotherGate.resolveUnknown('task', 'abandoned'), /still in flight/);
  const queued = anotherGate.run({ ...request, target: { ...request.target, appId: 'other-app' } }, () => true, async () => ++dispatched);
  rejectDispatch(new Error('unknown'));
  assert.deepEqual(await uncertain, { outcome: 'unknown' });
  await assert.rejects(queued, /reconcile/);
  assert.equal(dispatched, before);
  const recovered = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 100, journal,
    confirmApplication: async () => true, confirmObject: async () => true, audit: async () => {} });
  await assert.rejects(recovered.run(request, () => true, async () => ++dispatched), /reconcile/);
  await recovered.resolveUnknown('task', 'confirmed-not-applied');
  assert.equal((await recovered.run(request, () => true, async () => ++dispatched)).outcome, 'dispatched');
  console.log('desktop authority: task approval, exact object, audit failures, revocation and unknown dispatch passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
