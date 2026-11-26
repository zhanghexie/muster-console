import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-activity-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActivity } = await import(pathToFileURL(compile('main/desktop/desktopActivity.ts')));
  if (process.env.MUSTER_TEST_SINGLE_RENDER_FLUSH === '1') {
    // Regression control: waiting only the first promise can miss a render
    // that was enqueued by that very render.
    DesktopActivity.prototype.flushRendering = async function() {
      await this.rendered;
      if (this.visibilityFailure) throw this.visibilityFailure;
    };
  }
  const labels = { active: 'Using', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  let allowShow, showStarted;
  const started = new Promise(resolve => { showStarted = resolve; });
  const displayed = new Promise(resolve => { allowShow = resolve; });
  const snapshots = [];
  let closes = 0;
  const indicator = { show: async snapshot => { snapshots.push(snapshot); showStarted(); await displayed; }, close: () => { closes++; } };
  const activity = new DesktopActivity(indicator, async () => {}, labels);
  let current = true;
  let ready = false;
  const starting = activity.start(activity.createTurn('worker', 'turn-1', () => current), 'window').then(value => { ready = true; return value; });
  await started;
  assert.equal(ready, false, 'no desktop action can start until its indicator mounts');
  allowShow();
  const handle = await starting;
  assert.equal(snapshots[0].state, 'active');
  assert.equal(await activity.execute(handle, async () => 7), 7);
  current = false;
  await assert.rejects(activity.execute(handle, async () => 1), /no longer current/);
  activity.finish(handle);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(closes > 0, 'indicator closes when the final run finishes');

  const unavailable = new DesktopActivity({ show: async () => { throw new Error('cannot show'); }, close: () => {} }, async () => {}, labels);
  await assert.rejects(unavailable.start(unavailable.createTurn('worker', 'turn-2', () => true), 'window'), /cannot show/);
  await assert.rejects(unavailable.flushRendering(), /cannot show/, 'render failure must remain visible to a shutdown caller');

  let firstEntered, releaseFirst, secondEntered, releaseSecond, renders = 0;
  const firstShowing = new Promise(resolve => { firstEntered = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const chainedShowing = new Promise(resolve => { secondEntered = resolve; });
  const nextGate = new Promise(resolve => { releaseSecond = resolve; });
  let cascading;
  cascading = new DesktopActivity({ show: async () => {
    if (++renders === 1) { firstEntered(); await firstGate; cascading.setEscapeAvailable(true); }
    else if (renders === 2) { secondEntered(); await nextGate; }
  }, close: () => {} }, async () => {}, labels);
  const cascadingStart = cascading.start(cascading.createTurn('worker', 'render-chain', () => true), 'window');
  await firstShowing;
  let flushed = false;
  const flushedRendering = cascading.flushRendering().then(() => { flushed = true; });
  releaseFirst(); await chainedShowing; await Promise.resolve();
  assert.equal(flushed, false, 'flush waits for renders queued by an earlier render');
  releaseSecond(); await flushedRendering;
  assert.equal(renders, 2);
  cascading.finish(await cascadingStart);

  let unblock, entered;
  const showing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const interrupted = new DesktopActivity({ show: async () => { entered(); await gate; }, close: () => {} }, async () => {}, labels);
  const pending = interrupted.start(interrupted.createTurn('worker', 'turn-3', () => true), 'window');
  await showing;
  await interrupted.stop();
  unblock();
  await assert.rejects(pending, /ended before the indicator was ready/);
  let pendingAction, enteredAction;
  const actionStarted = new Promise(resolve => { enteredAction = resolve; });
  const actionGate = new Promise(resolve => { pendingAction = resolve; });
  const live = new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, labels);
  const liveHandle = await live.start(live.createTurn('live', 'turn-4', () => true), 'window');
  const activeAction = live.execute(liveHandle, async signal => { enteredAction(signal); await actionGate; return 1; });
  const actionResult = activeAction.catch(error => error);
  const activeSignal = await actionStarted;
  live.unavailable('window closed unexpectedly');
  assert.equal(activeSignal.aborted, true, 'losing the visible indicator must immediately request interruption');
  await assert.rejects(live.execute(liveHandle, async () => 2), /window closed unexpectedly/);
  pendingAction();
  assert.ok(await actionResult);
  const resumed = new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, labels);
  await resumed.start(resumed.createTurn('worker', 'turn-5', () => true), 'window');
  const oldOtherTurn = resumed.createTurn('other', 'other-turn', () => true);
  const queuedBeforeStop = resumed.noteUserInstruction('worker');
  await resumed.stop();
  const automaticAfterStop = resumed.createTurn('automatic-worker', 'automatic-after-stop', () => true);
  await assert.rejects(resumed.start(resumed.createTurn('worker', 'turn-6', () => true), 'window'), /new user instruction/);
  await assert.rejects(resumed.resumeForUserInstruction('worker', queuedBeforeStop), /predates the latest stop/);
  const fresh = resumed.noteUserInstruction('worker');
  await resumed.resumeForUserInstruction('worker', fresh);
  await assert.rejects(resumed.start(automaticAfterStop, 'window'), /new user instruction/,
    'one owner\'s new instruction must not rearm another owner\'s automatic post-stop turn');
  await assert.rejects(resumed.start(oldOtherTurn, 'window'), /was stopped/, 'a pre-stop turn that never used desktop cannot resume');
  await assert.rejects(resumed.start(resumed.createTurn('worker', 'turn-5', () => true, fresh), 'window'), /stopped desktop turn/);
  const newTurn = await resumed.start(resumed.createTurn('worker', 'turn-6', () => true, fresh), 'window');
  assert.equal(await resumed.execute(newTurn, async () => 9), 9);
  resumed.finish(newTurn);
  const multiSnapshots = [];
  let multiCloses = 0;
  const multi = new DesktopActivity({ show: async snapshot => { multiSnapshots.push(snapshot); }, close: () => { multiCloses++; } }, async () => {}, labels);
  const one = await multi.start(multi.createTurn('one', 'turn-a', () => true), '窗口 A');
  const two = await multi.start(multi.createTurn('two', 'turn-b', () => true), '窗口 B');
  multi.finish(one);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(multiSnapshots.at(-1).target, /窗口 B/);
  assert.equal(multiCloses, 0, 'finishing one worker must not hide another worker');
  multi.finish(two);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(multiCloses, 1, 'the indicator closes only after every worker has finished');

  let allowSecondShow, secondShowEntered, shows = 0;
  const secondShowing = new Promise(resolve => { secondShowEntered = resolve; });
  const secondGate = new Promise(resolve => { allowSecondShow = resolve; });
  const independent = new DesktopActivity({
    show: async () => { if (++shows === 2) { secondShowEntered(); await secondGate; } }, close: () => {}
  }, async () => {}, labels);
  const unaffected = await independent.start(independent.createTurn('a', 'a-turn', () => true), 'A');
  let secondCurrent = true;
  const obsolete = independent.start(independent.createTurn('b', 'b-turn', () => secondCurrent), 'B');
  await secondShowing;
  secondCurrent = false;
  allowSecondShow();
  await assert.rejects(obsolete, /ended before the indicator was ready/);
  assert.equal(unaffected.run.status, 'active', 'an obsolete startup must not stop another owner');
  assert.equal(await independent.execute(unaffected, async () => 11), 11);
  independent.finish(unaffected);

  let unknownEntered, unknownFinish;
  const unknownStarted = new Promise(resolve => { unknownEntered = resolve; });
  const unknownGate = new Promise(resolve => { unknownFinish = resolve; });
  const recovering = new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, labels);
  const oldHandle = await recovering.start(recovering.createTurn('recovering', 'old', () => true), 'window');
  const oldAction = recovering.execute(oldHandle, async signal => { unknownEntered(signal); await unknownGate; }).catch(error => error);
  await unknownStarted;
  const requestedStop = recovering.stop();
  unknownFinish();
  await requestedStop;
  assert.ok(await oldAction);
  assert.equal(oldHandle.run.status, 'unknown');
  const inspectInstruction = recovering.noteUserInstruction('recovering');
  await recovering.resumeForUserInstruction('recovering', inspectInstruction);
  const inspection = await recovering.start(recovering.createTurn('recovering', 'new', () => true, inspectInstruction), 'window');
  assert.equal(await recovering.execute(inspection, async () => 'observed'), 'observed',
    'a fresh human instruction must be able to open a new run for observation');
  recovering.finish(inspection);
  console.log('desktop activity: visible-before-use, stale turn and stop during startup passed');
} finally { removeWorkspaceFixture(temp, 'desktop-activity-'); }
