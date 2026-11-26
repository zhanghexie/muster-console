import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-resume-run-'));
const openLedgers = new Set();
let child;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const moduleFile = compile('main/desktop/desktopResumeState.ts');
  if (process.env.MUSTER_TEST_DISABLE_DIRTY_RECOVERY === '1') {
    const source = fs.readFileSync(moduleFile, 'utf8');
    const expected = /if\s*\(recoveredFromDirtyRun\)\s*this\.advanceStopGeneration\(\);/;
    assert.match(source, expected, 'negative control must find the compiled recovery step');
    fs.writeFileSync(moduleFile, source.replace(expected, 'if (recoveredFromDirtyRun) {}'));
  }
  if (process.env.MUSTER_TEST_DISABLE_RUN_NONCE_CAS === '1') {
    const source = fs.readFileSync(moduleFile, 'utf8');
    const expected = 'WHERE slot=1 AND dirty=1 AND nonce=?';
    assert.ok(source.includes(expected), 'negative control must find the nonce comparison');
    fs.writeFileSync(moduleFile, source.replace(expected, 'WHERE slot=1 AND dirty=1 AND (? IS NOT NULL)'));
  }
  const moduleUrl = pathToFileURL(moduleFile).href;
  const { DesktopResumeStateLedger } = await import(moduleUrl);
  const { DesktopActivity } = await import(pathToFileURL(compile('main/desktop/desktopActivity.ts')));
  const { DesktopTurns } = await import(pathToFileURL(compile('main/desktop/desktopTurns.ts')));
  const open = file => {
    const ledger = new DesktopResumeStateLedger(file);
    openLedgers.add(ledger);
    return ledger;
  };
  const close = ledger => { ledger.close(); openLedgers.delete(ledger); };
  const sql = (file, query) => {
    const db = new DatabaseSync(file);
    try { return query(db); } finally { db.close(); }
  };
  const snapshot = file => sql(file, db => ({
    version: db.prepare('PRAGMA user_version').get().user_version,
    generation: db.prepare('SELECT generation FROM desktop_stop_generation WHERE slot=1').get().generation,
    owners: db.prepare('SELECT COUNT(*) AS n FROM desktop_resume_owners').get().n,
    ...db.prepare('SELECT dirty,nonce FROM desktop_host_run WHERE slot=1').get(),
  }));
  const exec = (file, statement) => sql(file, db => db.exec(statement));
  const file = name => path.join(temp, `${name}.sqlite`);

  // A genuinely new database has no previous run to recover. A normal shutdown
  // preserves the stop generation and the owner's later authorization.
  const freshFile = file('fresh');
  let ledger = open(freshFile);
  assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: false });
  assert.equal(ledger.currentGeneration(), 0);
  const firstNonce = snapshot(freshFile).nonce;
  assert.match(firstNonce, /^[0-9a-f]{64}$/);
  ledger.markStopped();
  ledger.markResumed('owner-A');
  ledger.cleanRun();
  assert.throws(() => ledger.hasStopped(), /run is closed/);
  assert.deepEqual(snapshot(freshFile), { version: 2, generation: 1, owners: 1, dirty: 0, nonce: null });
  close(ledger);
  ledger = open(freshFile);
  assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: false });
  assert.equal(ledger.currentGeneration(), 1);
  assert.equal(ledger.isResumed('owner-A'), true);
  assert.notEqual(snapshot(freshFile).nonce, firstNonce);
  ledger.cleanRun();
  close(ledger);

  // A v1 database carries no clean-shutdown proof, even if it has owner grants.
  const legacyFile = file('legacy');
  sql(legacyFile, db => {
    db.exec(`CREATE TABLE desktop_stop_generation (slot INTEGER PRIMARY KEY CHECK(slot=1), generation INTEGER NOT NULL CHECK(generation>=0));
      INSERT INTO desktop_stop_generation VALUES (1,7);
      CREATE TABLE desktop_resume_owners (owner_hash TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>=1));
      PRAGMA user_version=1;`);
    const hash = createHash('sha256').update('old-owner', 'utf16le').digest('hex');
    db.prepare('INSERT INTO desktop_resume_owners VALUES (?,7)').run(hash);
  });
  ledger = open(legacyFile);
  assert.deepEqual(snapshot(legacyFile), { version: 2, generation: 7, owners: 1, dirty: 1, nonce: null });
  assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: true });
  assert.equal(ledger.currentGeneration(), 8);
  assert.equal(ledger.isResumed('old-owner'), false);
  ledger.markResumed('new-owner');
  ledger.cleanRun();
  close(ledger);
  ledger = open(legacyFile);
  assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: false });
  assert.equal(ledger.currentGeneration(), 8, 'legacy migration is recovered once after a clean shutdown');
  assert.equal(ledger.isResumed('new-owner'), true);
  ledger.cleanRun();
  close(ledger);

  // Real separate process is forcibly killed after its durable run marker and
  // grant are committed, without invoking cleanRun or closing its SQLite handle.
  const crashFile = file('crash');
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { DesktopResumeStateLedger } = await import(process.argv[1]);
    const ledger = new DesktopResumeStateLedger(process.argv[2]);
    ledger.beginRun(); ledger.markStopped(); ledger.markResumed('crash-owner');
    process.stdout.write('READY\\n'); setInterval(() => {}, 1000);
  `, moduleUrl, crashFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { childError += data; });
  let timer;
  try {
    const [ready] = await Promise.race([
      once(child.stdout, 'data'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('crash fixture did not start')), 10000).unref(); }),
    ]);
    assert.match(ready.toString(), /READY/, childError);
  } finally { clearTimeout(timer); }
  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGKILL'), true, 'the fixture must be forcibly terminated');
  const [code] = await exited;
  assert.notEqual(code, 0, childError);
  child = undefined;
  const beforeRecovery = snapshot(crashFile);
  assert.equal(beforeRecovery.dirty, 1);
  assert.equal(beforeRecovery.generation, 1);
  assert.equal(beforeRecovery.owners, 1);
  ledger = open(crashFile);
  assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: true });
  assert.equal(ledger.currentGeneration(), 2, 'a killed process invalidates its prior authorizations');
  assert.equal(ledger.isResumed('crash-owner'), false);
  ledger.cleanRun();
  close(ledger);
  ledger = open(crashFile);
  assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: false });
  assert.equal(ledger.currentGeneration(), 2);
  ledger.cleanRun();
  close(ledger);

  // A concurrent stop and a new instruction cannot slip between reading the
  // dirty marker and revoking owners: SQLite serializes the whole recovery.
  const raceFile = file('racing-stop');
  ledger = open(raceFile);
  ledger.beginRun(); ledger.markStopped(); ledger.markResumed('old-race-owner');
  close(ledger);
  ledger = open(raceFile);
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    import { createHash } from 'node:crypto';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE; UPDATE desktop_stop_generation SET generation=generation+1; DELETE FROM desktop_resume_owners;');
    const hash = createHash('sha256').update('racing-new-owner', 'utf16le').digest('hex');
    db.prepare('INSERT INTO desktop_resume_owners VALUES(?,2)').run(hash);
    process.stdout.write('LOCKED\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);
  `, raceFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { childError += data; });
  try {
    const [ready] = await Promise.race([
      once(child.stdout, 'data'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('race fixture did not lock')), 10000).unref(); }),
    ]);
    assert.match(ready.toString(), /LOCKED/, childError);
  } finally { clearTimeout(timer); }
  const raceExited = once(child, 'exit');
  assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: true });
  const [raceCode] = await raceExited;
  assert.equal(raceCode, 0, childError);
  child = undefined;
  assert.equal(ledger.currentGeneration(), 3);
  assert.equal(ledger.isResumed('old-race-owner'), false);
  assert.equal(ledger.isResumed('racing-new-owner'), false);
  ledger.cleanRun(); close(ledger);

  // Deliberately violate the outer single-instance prerequisite to prove an
  // old holder cannot clear a newer run's marker with its stale nonce.
  const casFile = file('cas');
  const old = open(casFile);
  old.beginRun();
  const current = open(casFile);
  assert.deepEqual(current.beginRun(), { recoveredFromDirtyRun: true });
  const currentNonce = snapshot(casFile).nonce;
  assert.throws(() => old.cleanRun(), /run changed/);
  assert.throws(() => old.currentGeneration(), /unavailable/);
  assert.equal(snapshot(casFile).nonce, currentNonce);
  assert.equal(snapshot(casFile).dirty, 1);
  current.cleanRun();
  close(old); close(current);

  // A failed recovery rolls back generation, owner deletion and run marker as
  // one unit and latches the ledger unavailable until a fresh open.
  const faultFile = file('recovery-fault');
  ledger = open(faultFile);
  ledger.beginRun(); ledger.markStopped(); ledger.markResumed('fault-owner');
  close(ledger);
  const beforeFault = snapshot(faultFile);
  exec(faultFile, "CREATE TRIGGER reject_run_update BEFORE UPDATE ON desktop_host_run BEGIN SELECT RAISE(ABORT, 'run update failed'); END;");
  ledger = open(faultFile);
  assert.throws(() => ledger.beginRun(), /run update failed/);
  assert.throws(() => ledger.currentGeneration(), /unavailable/);
  let reported;
  const labels = { active: 'Active', stopping: 'Stopping', unknown: 'Unknown', escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' };
  const turns = new DesktopTurns(new DesktopActivity({ show: async () => {}, close() {} }, async () => {}, labels,
    undefined, undefined, ledger, error => { reported = error; }));
  turns.noteUserInstruction('fault-owner', 'text-only');
  assert.doesNotThrow(() => turns.begin('fault-owner', 'text-turn', () => true, true, 'text-only'));
  await assert.rejects(turns.use('fault-owner', 'text-turn', 'fixture', async () => assert.fail('unsafe dispatch')),
    /stop state is unavailable/, 'a persistence error freezes desktop input without rejecting the text turn');
  assert.match(reported.message, /unavailable/);
  assert.deepEqual(snapshot(faultFile), beforeFault);
  close(ledger);
  exec(faultFile, 'DROP TRIGGER reject_run_update');
  ledger = open(faultFile);
  assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: true });
  assert.equal(ledger.currentGeneration(), beforeFault.generation + 1);
  assert.equal(ledger.isResumed('fault-owner'), false);
  ledger.cleanRun(); close(ledger);

  // An error during clean leaves the run dirty and revokes its grant next time.
  const cleanFaultFile = file('clean-fault');
  ledger = open(cleanFaultFile);
  ledger.beginRun(); ledger.markStopped(); ledger.markResumed('clean-owner');
  exec(cleanFaultFile, "CREATE TRIGGER reject_clean BEFORE UPDATE ON desktop_host_run BEGIN SELECT RAISE(ABORT, 'clean failed'); END;");
  assert.throws(() => ledger.cleanRun(), /clean failed/);
  assert.throws(() => ledger.isResumed('clean-owner'), /unavailable/);
  assert.equal(snapshot(cleanFaultFile).dirty, 1);
  close(ledger);
  exec(cleanFaultFile, 'DROP TRIGGER reject_clean');
  ledger = open(cleanFaultFile);
  assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: true });
  assert.equal(ledger.isResumed('clean-owner'), false);
  ledger.cleanRun(); close(ledger);

  for (const fault of [
    { name: 'stop-update', trigger: "CREATE TRIGGER reject_step BEFORE UPDATE ON desktop_stop_generation BEGIN SELECT RAISE(ABORT, 'stop update failed'); END;" },
    { name: 'owner-delete', trigger: "CREATE TRIGGER reject_step BEFORE DELETE ON desktop_resume_owners BEGIN SELECT RAISE(ABORT, 'owner deletion failed'); END;" },
  ]) {
    const stepFile = file(fault.name);
    ledger = open(stepFile);
    ledger.beginRun(); ledger.markStopped(); ledger.markResumed('step-owner'); close(ledger);
    const beforeStep = snapshot(stepFile);
    exec(stepFile, fault.trigger);
    ledger = open(stepFile);
    assert.throws(() => ledger.beginRun(), /failed/);
    assert.throws(() => ledger.hasStopped(), /unavailable/);
    assert.deepEqual(snapshot(stepFile), beforeStep, `${fault.name} rolls back every recovery write`);
    close(ledger);
    exec(stepFile, 'DROP TRIGGER reject_step');
    ledger = open(stepFile);
    assert.deepEqual(ledger.beginRun(), { recoveredFromDirtyRun: true });
    assert.equal(ledger.isResumed('step-owner'), false);
    ledger.cleanRun(); close(ledger);
  }

  // A broken v1 migration must not partially upgrade or reset the old state.
  const brokenFile = file('broken-migration');
  sql(brokenFile, db => db.exec(`CREATE TABLE desktop_stop_generation (slot INTEGER PRIMARY KEY, generation INTEGER NOT NULL);
    INSERT INTO desktop_stop_generation VALUES (1,3);
    CREATE TABLE desktop_resume_owners (owner_hash TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    CREATE TABLE desktop_host_run (conflict INTEGER);
    PRAGMA user_version=1;`));
  assert.throws(() => open(brokenFile), /already exists/);
  assert.deepEqual(sql(brokenFile, db => ({
    version: db.prepare('PRAGMA user_version').get().user_version,
    generation: db.prepare('SELECT generation FROM desktop_stop_generation').get().generation,
  })), { version: 1, generation: 3 });

  const invalidFile = file('invalid');
  ledger = open(invalidFile); close(ledger);
  exec(invalidFile, 'DROP TABLE desktop_host_run');
  assert.throws(() => open(invalidFile), /desktop_host_run/);
  console.log('desktop resume run lifecycle: new, migration, kill, CAS and SQLite faults passed');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const finished = once(child, 'exit').catch(() => {});
    child.kill('SIGKILL');
    await finished;
  }
  for (const ledger of openLedgers) ledger.close();
  removeWorkspaceFixture(temp, 'desktop-resume-run-');
}
