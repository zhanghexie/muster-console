import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-resume-state-'));
let ledger;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const moduleFile = compile('main/desktop/desktopResumeState.ts');
  const { DesktopResumeStateLedger } = await import(pathToFileURL(moduleFile));
  const { DesktopActivity } = await import(pathToFileURL(compile('main/desktop/desktopActivity.ts')));
  const { DesktopActivityRuntime } = await import(pathToFileURL(compile('main/desktop/desktopActivityRuntime.ts')));
  const { DesktopTurns } = await import(pathToFileURL(compile('main/desktop/desktopTurns.ts')));
  const labels = { active: 'Active', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const createTurns = (state, report = () => {}) => new DesktopTurns(new DesktopActivity(
    { show: async () => {}, close() {} }, async () => {}, labels, undefined, undefined, state, report));
  const file = path.join(temp, 'desktop', 'resume.sqlite');

  let openFailure;
  const unavailable = createTurns({ hasStopped() { throw new Error('stop state unreadable'); }, isResumed() { return false; },
    markStopped() {}, markResumed() {} }, error => { openFailure = error; });
  assert.match(openFailure.message, /stop state unreadable/);
  unavailable.noteUserInstruction('owner-A', 'text-still-allowed');
  assert.doesNotThrow(() => unavailable.begin('owner-A', 'text-turn', () => true, true, 'text-still-allowed'));
  await assert.rejects(unavailable.use('owner-A', 'text-turn', 'fixture', async () => assert.fail('unsafe dispatch')), /stop state is unavailable/);

  let failingRead = true, readError;
  const unreadable = createTurns({ hasStopped: () => true, isResumed() {
    if (failingRead) throw new Error('resume state read failed'); return true;
  }, markStopped() {}, markResumed() {} }, error => { readError = error; });
  unreadable.begin('owner-A', 'read-failure', () => true);
  await assert.rejects(unreadable.use('owner-A', 'read-failure', 'fixture', async () => assert.fail('unsafe dispatch')), /stop state is unavailable/);
  assert.match(readError.message, /resume state read failed/);
  failingRead = false;
  unreadable.noteUserInstruction('owner-A', 'after-read-failure');
  unreadable.begin('owner-A', 'after-read-failure', () => true, true, 'after-read-failure');
  await assert.rejects(unreadable.use('owner-A', 'after-read-failure', 'fixture', async () => assert.fail('unsafe dispatch')), /stop state is unavailable/,
    'a later apparently successful read cannot revive a failed persistent state');

  const incomplete = path.join(temp, 'incomplete.sqlite');
  fs.writeFileSync(incomplete, '');
  assert.throws(() => new DesktopResumeStateLedger(incomplete), /not fully initialized/,
    'an existing incomplete database must not be silently reset to an unstopped state');

  const corrupt = path.join(temp, 'corrupt.sqlite');
  const damaged = new DesktopResumeStateLedger(corrupt); damaged.markStopped(); damaged.close();
  const damageDb = new DatabaseSync(corrupt); damageDb.exec('DROP TABLE desktop_resume_owners'); damageDb.close();
  assert.throws(() => new DesktopResumeStateLedger(corrupt), /desktop_resume_owners/,
    'a missing owner table must not be recreated and interpreted as a clean state');

  const idleLedger = new DesktopResumeStateLedger(path.join(temp, 'idle.sqlite'));
  const idle = new DesktopActivityRuntime({ labels, resumeState: idleLedger, releaseAll: async () => {},
    createIndicator: () => ({ show: async () => {}, close() {} }) });
  await idle.dispose();
  assert.equal(idleLedger.hasStopped(), false, 'closing an idle workbench is not a user stop');
  idleLedger.close();

  const unknownLedger = new DesktopResumeStateLedger(path.join(temp, 'unknown.sqlite'));
  const uncertain = createTurns(unknownLedger);
  uncertain.begin('uncertain-owner', 'uncertain-turn', () => true);
  await assert.rejects(uncertain.use('uncertain-owner', 'uncertain-turn', 'fixture', async () => {
    throw new Error('action outcome unavailable');
  }), /action outcome unavailable/);
  assert.equal(unknownLedger.hasStopped(), true, 'an uncertain in-flight action must also survive restart as stopped');
  unknownLedger.close();

  ledger = new DesktopResumeStateLedger(file);
  assert.equal(ledger.hasStopped(), false);
  const before = createTurns(ledger);
  before.begin('owner-A', 'original', () => true);
  assert.equal(await before.use('owner-A', 'original', 'fixture', async () => 'first'), 'first');
  before.noteUserInstruction('owner-A', 'queued-before-stop');
  await before.stop();
  assert.equal(ledger.hasStopped(), true);
  assert.equal(ledger.isResumed('owner-A'), false);
  ledger.close(); ledger = undefined;

  // A fresh process must see the stop, even though it has no prior in-memory turns.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {DesktopResumeStateLedger}=await import(process.argv[1]);
    const s=new DesktopResumeStateLedger(process.argv[2]);
    process.stdout.write(JSON.stringify({stopped:s.hasStopped(),resumed:s.isResumed('owner-A')}));s.close();
  `, pathToFileURL(moduleFile).href, file], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { stopped: true, resumed: false });

  ledger = new DesktopResumeStateLedger(file);
  const resumed = createTurns(ledger);
  resumed.begin('owner-A', 'automatic-after-restart', () => true);
  await assert.rejects(resumed.use('owner-A', 'automatic-after-restart', 'fixture', async () => assert.fail('automatic dispatch')), /new user instruction/);
  assert.doesNotThrow(() => resumed.begin('owner-A', 'stale-queued', () => true, true, 'queued-before-stop'),
    'an old instruction must not prevent the surrounding text turn from starting');
  await assert.rejects(resumed.use('owner-A', 'stale-queued', 'fixture', async () => assert.fail('stale dispatch')), /not accepted/);
  resumed.noteUserInstruction('owner-A', 'fresh-instruction');
  resumed.begin('owner-A', 'fresh-turn', () => true, true, 'fresh-instruction');
  assert.equal(await resumed.use('owner-A', 'fresh-turn', 'fixture', async () => 'resumed'), 'resumed');
  resumed.end('owner-A', 'fresh-turn');
  resumed.begin('owner-A', 'queued-automatic-before-stop', () => true);
  await assert.rejects(resumed.use('owner-A', 'queued-automatic-before-stop', 'fixture', async () => assert.fail('old automatic dispatch')),
    /new user instruction/, 'a fresh instruction must not reauthorize an older automatic turn');
  assert.equal(ledger.isResumed('owner-A'), true);
  assert.equal(ledger.isResumed('owner-B'), false, 'one owner cannot authorize a different session');
  const stored = new DatabaseSync(file, { readOnly: true });
  assert.notEqual(stored.prepare('SELECT owner_hash FROM desktop_resume_owners').get().owner_hash, 'owner-A');
  stored.close();
  ledger.close(); ledger = undefined;

  ledger = new DesktopResumeStateLedger(file);
  const reopened = createTurns(ledger);
  reopened.begin('owner-A', 'automatic-after-fresh-instruction', () => true);
  await assert.rejects(reopened.use('owner-A', 'automatic-after-fresh-instruction', 'fixture', async () => assert.fail('old auto dispatched')),
    /new user instruction/, 'an owner resume alone does not prove an automatic task was created after the stop');
  reopened.noteUserInstruction('owner-A', 'new-after-restart');
  reopened.begin('owner-A', 'user-after-restart', () => true, true, 'new-after-restart');
  assert.equal(await reopened.use('owner-A', 'user-after-restart', 'fixture', async () => 'allowed'), 'allowed');
  reopened.begin('owner-B', 'other-auto', () => true);
  await assert.rejects(reopened.use('owner-B', 'other-auto', 'fixture', async () => assert.fail('other owner dispatch')), /new user instruction/);
  await reopened.stop();
  assert.equal(ledger.isResumed('owner-A'), false, 'a later stop revokes every owner');
  const malformedA = 'owner-\ud800', malformedB = 'owner-\udc00';
  ledger.markResumed(malformedA);
  assert.equal(ledger.isResumed(malformedA), true);
  assert.equal(ledger.isResumed(malformedB), false, 'distinct UTF-16 owners must not share a resume record');
  ledger.close(); ledger = undefined;

  // A write error must not prevent immediate abort or become a false resume.
  ledger = new DesktopResumeStateLedger(file);
  const fault = new DatabaseSync(file);
  fault.exec("CREATE TRIGGER reject_stop BEFORE UPDATE ON desktop_stop_generation BEGIN SELECT RAISE(ABORT, 'simulated stop persistence failure'); END;");
  let reported;
  const failing = createTurns(ledger, error => { reported = error; });
  failing.noteUserInstruction('owner-A', 'before-fault');
  failing.begin('owner-A', 'before-fault-turn', () => true, true, 'before-fault');
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const work = failing.use('owner-A', 'before-fault-turn', 'fixture', signal => new Promise((_, reject) => {
    entered(signal);
    signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
  })).catch(error => error);
  const signal = await started;
  const stopped = failing.stop();
  assert.equal(signal.aborted, true, 'stop aborts in-flight input before persistent I/O');
  await assert.rejects(stopped, /simulated stop persistence failure/);
  assert.match(reported.message, /simulated stop persistence failure/);
  await work;
  failing.noteUserInstruction('owner-A', 'after-fault');
  failing.begin('owner-A', 'after-fault-turn', () => true, true, 'after-fault');
  await assert.rejects(failing.use('owner-A', 'after-fault-turn', 'fixture', async () => assert.fail('unsafe resume')), /stop state is unavailable/);
  fault.exec('DROP TRIGGER reject_stop'); fault.close();
  console.log('desktop resume state: durable stop, scoped instruction, restart and persistence failure passed');
} finally {
  ledger?.close();
  removeWorkspaceFixture(temp, 'desktop-resume-state-');
}
