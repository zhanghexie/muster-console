import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-screen-authority-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { ScreenReadAuthority } = await import(pathToFileURL(compile('main/desktop/screenReadAuthority.ts')));
  const { DesktopDispatchJournal } = await import(pathToFileURL(compile('main/desktop/dispatchJournal.ts')));
  const journalDir = path.join(temp, 'journal'), journal = new DesktopDispatchJournal(journalDir);
  const target = { taskId: 'task', surfaceId: 'surface', surfaceGeneration: 'g', geometryRevision: 'r', displayId: 1,
    bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1 };
  let prompts = 0, allow = true, auditFailure = false;
  const decisions = [];
  const confirm = async () => { prompts++; return allow; };
  const audit = async (_id, _target, result) => { decisions.push(result); if (auditFailure) throw new Error('audit unavailable'); };
  const authority = new ScreenReadAuthority(journal, confirm, audit);
  await assert.rejects(authority.authorize('session', { ...target, bounds: null }, () => true), /Invalid/);
  assert.equal(prompts, 0);
  const [token] = await Promise.all([authority.authorize('session', target, () => true), authority.authorize('session', target, () => true)]);
  assert.equal(prompts, 1, 'same-session requests share one explicit consent');
  await authority.authorize('session', { ...target, displayId: 2 }, () => true);
  assert.equal(prompts, 1, 'consent covers all displays, not an invented narrow capture');
  assert.equal(authority.isAuthorized('session', 'task', token), true);
  const revoke = authority.revoke('session');
  assert.equal(authority.isAuthorized('session', 'task', token), false, 'revocation immediately invalidates in-flight tokens');
  await revoke;
  allow = false;
  await assert.rejects(authority.authorize('other', target, () => true), /declined/);
  await assert.rejects(authority.authorize('other', target, () => true), /previously declined/);
  const restored = new ScreenReadAuthority(new DesktopDispatchJournal(journalDir), confirm, audit);
  await assert.rejects(restored.authorize('other', target, () => true), /previously declined/);
  auditFailure = true;
  await assert.rejects(authority.reconsiderAfterUserRequest('other'), /audit unavailable/);
  auditFailure = false;
  await assert.rejects(restored.authorize('other', target, () => true), /previously declined/);
  await authority.reconsiderAfterUserRequest('other'); allow = true;
  await authority.authorize('other', target, () => true);
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const raced = new ScreenReadAuthority(new DesktopDispatchJournal(path.join(temp, 'race')),
    async () => { entered(); return new Promise(resolve => { finish = resolve; }); }, audit);
  const beforeRace = decisions.length;
  const pending = raced.authorize('race', target, () => true);
  await started;
  const revoked = raced.revoke('race'); finish(true);
  await assert.rejects(pending, /changed/);
  await revoked;
  await assert.rejects(raced.authorize('race', target, () => true), /previously declined/);
  assert.deepEqual(decisions.slice(beforeRace), ['revoked'], 'revocation cannot be reported as an approval');
  let cancelEntered, cancelFinish;
  const cancelStarted = new Promise(resolve => { cancelEntered = resolve; });
  const cancellable = new ScreenReadAuthority(new DesktopDispatchJournal(path.join(temp, 'cancel')),
    async () => { cancelEntered(); return new Promise(resolve => { cancelFinish = resolve; }); }, audit);
  const controller = new AbortController(), beforeCancel = decisions.length;
  const cancelled = cancellable.authorize('cancelled', target, () => true, controller.signal);
  await cancelStarted; controller.abort(); cancelFinish(true);
  await assert.rejects(cancelled, /abort/i);
  assert.deepEqual(decisions.slice(beforeCancel), [], 'cancelled confirmation cannot be recorded as approval');
  let clock = 0, epochPrompts = 0;
  const epoch = new ScreenReadAuthority(new DesktopDispatchJournal(path.join(temp, 'epoch')),
    async () => { epochPrompts++; return true; }, async () => {}, () => clock);
  const original = await epoch.authorize('long-session', target, () => true);
  const next = await epoch.authorize('long-session', { ...target, taskId: 'next-task' }, () => true);
  assert.equal(epoch.isAuthorized('long-session', 'task', original), false, 'task replacement invalidates old token');
  assert.equal(epoch.isAuthorized('long-session', 'next-task', next), true);
  assert.equal(epochPrompts, 2, 'a different task requires fresh consent');
  clock += 24 * 60 * 60 * 1000;
  assert.equal(epoch.isAuthorized('long-session', 'next-task', next), false, 'consent expires after 24 hours');
  const renewed = await epoch.authorize('long-session', { ...target, taskId: 'next-task' }, () => true);
  assert.equal(epochPrompts, 3);
  assert.notEqual(renewed, next, 'renewal never revives the expired token');
  assert.equal(epoch.isAuthorized('long-session', 'next-task', next), false);
  assert.equal(epoch.isAuthorized('long-session', 'next-task', renewed), true);
  await assert.rejects(epoch.authorize('long-session', target, () => false), /changed/);
  assert.equal(epoch.isAuthorized('long-session', 'next-task', renewed), true, 'a stale task cannot invalidate the current task');
  let raceEntered, raceRelease;
  const raceStarted = new Promise(resolve => { raceEntered = resolve; });
  const switched = new ScreenReadAuthority(new DesktopDispatchJournal(path.join(temp, 'switch')),
    async (_session, selected) => selected.taskId === 'task'
      ? new Promise(resolve => { raceEntered(); raceRelease = resolve; }) : true, async () => {});
  const oldPending = switched.authorize('session', target, () => true);
  await raceStarted;
  const newPending = switched.authorize('session', { ...target, taskId: 'new-task' }, () => true);
  raceRelease(true);
  await assert.rejects(oldPending, /changed/, 'task replacement invalidates an in-flight confirmation');
  const switchedToken = await newPending;
  assert.equal(switched.isAuthorized('session', 'new-task', switchedToken), true);
  console.log('screen read authority: session consent, durable denial, revocation and audit passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
