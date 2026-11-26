import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-unknown-continue-'));
const opened = new Set(), deferred = [], children = new Set();
const digest = value => createHash('sha256').update(value).digest('hex');
const dbFile = root => path.join(root, 'global-desktop-write.sqlite');
const lockKey = 'muster-global-desktop-write-v1';
const context = requestId => ({ requestId, sessionId: 'session', taskId: 'task', action: 'click', target: 'window',
  fingerprint: 'a'.repeat(64), isCurrent: () => true, timeoutMs: 1000 });
const hashes = requestId => ({ request: digest(requestId), context: digest(JSON.stringify(['session', 'task', 'click', 'window', null])),
  fingerprint: digest('a'.repeat(64)) });

// Exact v1 shape: control/version and history phase CHECK constraints both need migration.
function v1Fixture(root, phase) {
  fs.mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(dbFile(root)), instance = randomUUID(), operationId = randomUUID();
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE global_desktop_control(slot INTEGER PRIMARY KEY CHECK(slot=1),version INTEGER NOT NULL CHECK(version=1),instance TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready IN (0,1)));
    CREATE TABLE global_desktop_history(request_hash TEXT PRIMARY KEY,context_hash TEXT NOT NULL,fingerprint_hash TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL,result_hash TEXT,token_hash TEXT,audit_hash TEXT,resolution TEXT,
      CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK(length(context_hash)=64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK(length(fingerprint_hash)=64 AND fingerprint_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK(result_hash IS NULL OR (length(result_hash)=64 AND result_hash NOT GLOB '*[^0-9a-f]*')),
      CHECK(token_hash IS NULL OR (length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*')),
      CHECK(audit_hash IS NULL OR (length(audit_hash)=64 AND audit_hash NOT GLOB '*[^0-9a-f]*')),
      CHECK((phase IN ('prepared','unknown') AND result_hash IS NULL AND token_hash IS NULL AND audit_hash IS NULL AND resolution IS NULL) OR
        (phase='known' AND result_hash IS NOT NULL AND token_hash IS NOT NULL AND audit_hash IS NULL AND resolution IS NULL) OR
        (phase='confirmed' AND result_hash IS NOT NULL AND token_hash IS NOT NULL AND audit_hash IS NOT NULL AND resolution IS NULL) OR
        (phase='resolved' AND audit_hash IS NOT NULL AND resolution IS NOT NULL AND resolution IN ('confirmed-applied','confirmed-not-applied') AND
          ((result_hash IS NULL AND token_hash IS NULL) OR (result_hash IS NOT NULL AND token_hash IS NOT NULL)))));
    CREATE INDEX global_desktop_history_phase ON global_desktop_history(phase);
    CREATE TABLE global_desktop_marker(slot INTEGER PRIMARY KEY CHECK(slot=1),request_hash TEXT NOT NULL UNIQUE REFERENCES global_desktop_history(request_hash),operation_id TEXT NOT NULL UNIQUE);
    CREATE TABLE global_desktop_legacy_control(slot INTEGER PRIMARY KEY CHECK(slot=1),receipt_count INTEGER NOT NULL CHECK(receipt_count>=0),manifest_hash TEXT NOT NULL);
    CREATE TABLE global_desktop_legacy_receipts(root_hash TEXT NOT NULL,request_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,result_hash TEXT NOT NULL,
      format TEXT NOT NULL,delivery_state TEXT NOT NULL CHECK(delivery_state='unverified'),PRIMARY KEY(root_hash,request_hash));
    CREATE INDEX global_desktop_legacy_request ON global_desktop_legacy_receipts(request_hash);`);
  db.prepare('INSERT INTO global_desktop_control VALUES(1,1,?,1)').run(instance);
  db.prepare('INSERT INTO global_desktop_legacy_control VALUES(1,0,?)').run(digest('[]'));
  const h = hashes('v1-request'), r = phase === 'known' ? 'd'.repeat(64) : null, t = phase === 'known' ? 'e'.repeat(64) : null;
  db.prepare('INSERT INTO global_desktop_history VALUES(?,?,?,?,?,?,?,?,?)').run(h.request, h.context, h.fingerprint, operationId, phase, r, t, null, null);
  db.prepare('INSERT INTO global_desktop_marker VALUES(1,?,?)').run(h.request, operationId);
  const old = hashes('v1-confirmed');
  db.prepare('INSERT INTO global_desktop_history VALUES(?,?,?,?,?,?,?,?,?)').run(old.request, old.context, old.fingerprint, randomUUID(),
    'confirmed', '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), null);
  const resolved = hashes('v1-resolved');
  db.prepare('INSERT INTO global_desktop_history VALUES(?,?,?,?,?,?,?,?,?)').run(resolved.request, resolved.context, resolved.fingerprint, randomUUID(),
    'resolved', null, null, '4'.repeat(64), 'confirmed-not-applied');
  db.close();
  return { instance, operationId, requestHash: h.request };
}

try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { GlobalDesktopWriteBarrier } = await import(pathToFileURL(compile('main/desktop/globalDesktopWriteBarrier.ts')));
  const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
    legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyLegacyDelivery: () => true, verifyLegacyResolution: () => true };
  const events = new WeakMap();
  let stopped = true, eventValid = true, stopChecks = 0, revokeStopAt = -1, eventChecks = 0, changeEventAt = -1;
  const authority = { legacyWritersExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyDelivery: () => true, executorStopped: () => { stopChecks++; return stopped && stopChecks !== revokeStopAt; },
    verifyRecovery: () => true, verifyAbandonedLock: () => true, verifyStorageUpgrade: () => true,
    verifyUnknownContinuation({ marker, authorization }) {
      eventChecks++;
      const event = events.get(authorization);
      if (!eventValid || !event || event.marker !== JSON.stringify(marker) || !event.knewUnknown || !event.explicitContinue) return null;
      return eventChecks === changeEventAt ? `${event.id}-changed` : event.id;
    } };
  const grant = (marker, id, overrides = {}) => {
    const proof = Object.freeze({});
    events.set(proof, { marker: JSON.stringify(marker), id, knewUnknown: true, explicitContinue: true, ...overrides });
    return proof;
  };
  const open = root => { const item = GlobalDesktopWriteBarrier.open(root, authority); opened.add(item); return item; };
  const close = item => { item.close(); opened.delete(item); };
  const create = async name => {
    const root = path.join(temp, name);
    const item = await GlobalDesktopWriteBarrier.activate({ root, legacyRoots: [root], legacyOutboxes: [], fence, authority });
    opened.add(item); return { root, item };
  };
  const uncertain = async (item, requestId) => {
    const result = await item.run(context(requestId), async () => ({ outcome: 'unknown' }));
    assert.equal(result.outcome, 'unknown'); return result;
  };

  for (const phase of ['prepared', 'unknown', 'known']) {
    const root = path.join(temp, `v1-${phase}`), original = v1Fixture(root, phase), item = open(root);
    const marker = item.inspect();
    assert.equal(marker.operationId, original.operationId); assert.equal(marker.phase, phase);
    const db = new DatabaseSync(dbFile(root));
    const control = db.prepare('SELECT version,instance,ready FROM global_desktop_control').get();
    assert.deepEqual({ ...control }, { version: 2, instance: original.instance, ready: 1 });
    assert.equal(db.prepare('SELECT count(*) AS n FROM global_desktop_history').get().n, 3);
    assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined); db.close();
    const proof = grant(marker, `v1-event-${phase}`);
    assert.deepEqual(await item.acknowledgeUnknown(marker.operationId, proof, () => true), { outcome: 'acknowledged-unknown' });
    assert.equal(item.inspect(), null);
    const check = new DatabaseSync(dbFile(root));
    const row = check.prepare('SELECT phase,result_hash,token_hash,audit_hash,resolution FROM global_desktop_history WHERE operation_id=?').get(marker.operationId);
    assert.equal(row.phase, 'acknowledged-unknown'); assert.equal(row.resolution, null);
    assert.equal(row.result_hash, phase === 'known' ? 'd'.repeat(64) : null);
    assert.equal(row.token_hash, phase === 'known' ? 'e'.repeat(64) : null);
    assert.equal(row.audit_hash, digest(JSON.stringify(['global-desktop-unknown-continuation-v1', `v1-event-${phase}`]))); check.close();
    close(item);
    const reopened = open(root);
    const previous = await reopened.run(context('v1-request'), async () => assert.fail('acknowledged request replayed'));
    assert.equal(previous.outcome, 'unknown'); assert.equal(previous.recordedRequest, true); assert.equal(previous.operationId, original.operationId);
    const terminal = await reopened.run(context('v1-confirmed'), async () => assert.fail('v1 confirmed request replayed'));
    assert.equal(terminal.outcome, 'unknown'); assert.equal(terminal.recordedRequest, true);
    const resolved = await reopened.run(context('v1-resolved'), async () => assert.fail('v1 resolved request replayed'));
    assert.equal(resolved.outcome, 'unknown'); assert.equal(resolved.recordedRequest, true);
    const next = await uncertain(reopened, `next-${phase}`);
    await reopened.acknowledgeUnknown(next.operationId, grant(reopened.inspect(), `next-event-${phase}`), () => true);
    close(reopened);
  }

  // Upgrading an active v1 installation requires a live host exclusion fence.
  {
    const root = path.join(temp, 'v1-fence'), original = v1Fixture(root, 'known');
    assert.throws(() => GlobalDesktopWriteBarrier.open(root, { ...authority, verifyStorageUpgrade: undefined }), /exclusive host fence/i);
    let checks = 0;
    assert.throws(() => GlobalDesktopWriteBarrier.open(root, { ...authority, verifyStorageUpgrade: () => ++checks < 2 }), /exclusive host fence/i);
    const db = new DatabaseSync(dbFile(root));
    assert.equal(db.prepare('SELECT version FROM global_desktop_control').get().version, 1, 'lost fence rolls back schema migration');
    assert.equal(db.prepare('SELECT operation_id FROM global_desktop_marker').get().operation_id, original.operationId); db.close();
    const item = open(root); assert.equal(item.inspect().operationId, original.operationId); close(item);
  }

  // Failed migration rolls back table renames and keeps the v1 marker intact.
  {
    const root = path.join(temp, 'v1-rollback'), original = v1Fixture(root, 'prepared');
    const db = new DatabaseSync(dbFile(root)); db.exec('CREATE TABLE global_desktop_history_v1(block INTEGER)'); db.close();
    assert.throws(() => open(root));
    const unchanged = new DatabaseSync(dbFile(root));
    assert.equal(unchanged.prepare('SELECT version FROM global_desktop_control').get().version, 1);
    assert.equal(unchanged.prepare('SELECT operation_id FROM global_desktop_marker').get().operation_id, original.operationId);
    unchanged.exec('DROP TABLE global_desktop_history_v1'); unchanged.close();
    const item = open(root); assert.equal(item.inspect().operationId, original.operationId); close(item);
  }
  {
    const root = path.join(temp, 'v1-corrupt'), original = v1Fixture(root, 'unknown');
    const db = new DatabaseSync(dbFile(root)); db.exec('PRAGMA foreign_keys=OFF; DELETE FROM global_desktop_history'); db.close();
    assert.throws(() => open(root), /inconsistent|foreign/i);
    const unchanged = new DatabaseSync(dbFile(root)); assert.equal(unchanged.prepare('SELECT version FROM global_desktop_control').get().version, 1);
    assert.equal(unchanged.prepare('SELECT operation_id FROM global_desktop_marker').get().operation_id, original.operationId); unchanged.close();
  }

  const { root, item } = await create('security');
  const first = await uncertain(item, 'first'), marker = item.inspect(), valid = grant(marker, 'event-shared');
  await assert.rejects(item.acknowledgeUnknown(first.operationId, 'model-text', () => true), /trusted user/i);
  await assert.rejects(item.acknowledgeUnknown(first.operationId, {}, () => true), /matching trusted/i);
  await assert.rejects(item.acknowledgeUnknown(first.operationId, grant(marker, 'uninformed', { knewUnknown: false }), () => true), /matching trusted/i);
  await assert.rejects(item.acknowledgeUnknown(first.operationId, grant(marker, 'ordinary-message', { explicitContinue: false }), () => true), /matching trusted/i);
  await assert.rejects(item.acknowledgeUnknown(first.operationId, grant({ operationId: randomUUID() }, 'wrong-marker'), () => true), /matching trusted/i);
  await assert.rejects(item.acknowledgeUnknown(first.operationId, grant({ ...marker, phase: 'prepared' }, 'wrong-phase'), () => true), /matching trusted/i);
  await assert.rejects(item.acknowledgeUnknown(first.operationId, valid, () => false), /executor must be stopped/i);
  stopped = false; await assert.rejects(item.acknowledgeUnknown(first.operationId, valid, () => true), /executor must be stopped/i); stopped = true;
  eventValid = false; await assert.rejects(item.acknowledgeUnknown(first.operationId, valid, () => true), /matching trusted/i); eventValid = true;
  const noVerifier = GlobalDesktopWriteBarrier.open(root, { ...authority, verifyUnknownContinuation: undefined }); opened.add(noVerifier);
  await assert.rejects(noVerifier.acknowledgeUnknown(first.operationId, valid, () => true), /verification is unavailable/i); close(noVerifier);
  const held = await item.lock.acquire(lockKey);
  try { await assert.rejects(item.acknowledgeUnknown(first.operationId, valid, () => true), /locked/i); }
  finally { await held(); }
  const originalAcquire = item.lock.acquire;
  item.lock.acquire = async function(...args) {
    const release = await originalAcquire.apply(this, args);
    return async () => { await release(); throw new Error('simulated lock-release uncertainty'); };
  };
  try { assert.deepEqual(await item.acknowledgeUnknown(first.operationId, valid, () => true), { outcome: 'unknown', reason: 'lock-release-failed' }); }
  finally { item.lock.acquire = originalAcquire; }
  assert.equal(item.inspect().operationId, first.operationId);
  stopChecks = 0; revokeStopAt = 4;
  assert.deepEqual(await item.acknowledgeUnknown(first.operationId, valid, () => true), { outcome: 'unknown', reason: 'barrier-finalization-failed' });
  revokeStopAt = -1; assert.equal(item.inspect().operationId, first.operationId, 'failed final authorization rolls back both writes');
  eventChecks = 0; changeEventAt = 2;
  assert.deepEqual(await item.acknowledgeUnknown(first.operationId, valid, () => true), { outcome: 'unknown', reason: 'current-changed' });
  changeEventAt = -1; assert.equal(item.inspect().operationId, first.operationId);
  const failing = new DatabaseSync(dbFile(root));
  failing.exec("CREATE TRIGGER deny_ack BEFORE UPDATE ON global_desktop_history WHEN NEW.phase='acknowledged-unknown' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.deepEqual(await item.acknowledgeUnknown(first.operationId, valid, () => true), { outcome: 'unknown', reason: 'barrier-finalization-failed' });
  assert.equal(item.inspect().operationId, first.operationId); failing.exec('DROP TRIGGER deny_ack');
  failing.exec("CREATE TRIGGER deny_delete BEFORE DELETE ON global_desktop_marker BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.deepEqual(await item.acknowledgeUnknown(first.operationId, valid, () => true), { outcome: 'unknown', reason: 'barrier-finalization-failed' });
  assert.equal(item.inspect().operationId, first.operationId); failing.exec('DROP TRIGGER deny_delete');
  failing.exec("CREATE TRIGGER deny_manifest BEFORE UPDATE OF history_hash ON global_desktop_control BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.deepEqual(await item.acknowledgeUnknown(first.operationId, valid, () => true), { outcome: 'unknown', reason: 'barrier-finalization-failed' });
  assert.equal(item.inspect().operationId, first.operationId); failing.exec('DROP TRIGGER deny_manifest'); failing.close();
  assert.deepEqual(await item.acknowledgeUnknown(first.operationId, valid, () => true), { outcome: 'acknowledged-unknown' });
  const again = await item.run(context('first'), async () => assert.fail('same request replayed'));
  assert.equal(again.outcome, 'unknown'); assert.equal(again.operationId, first.operationId); assert.equal(again.recordedRequest, true);
  await assert.rejects(item.run({ ...context('first'), fingerprint: 'b'.repeat(64) }, async () => assert.fail('changed request replayed')),
    /different operation/i);
  const second = await uncertain(item, 'second');
  assert.deepEqual(await item.acknowledgeUnknown(second.operationId, grant(item.inspect(), 'event-shared'), () => true),
    { outcome: 'unknown', reason: 'barrier-finalization-failed' }, 'one event cannot clear two operations');
  assert.equal(item.inspect().operationId, second.operationId);
  assert.deepEqual(await item.acknowledgeUnknown(second.operationId, grant(item.inspect(), 'event-second'), () => true), { outcome: 'acknowledged-unknown' });

  let settle;
  const timed = await item.run({ ...context('in-flight'), timeoutMs: 10 }, async () => new Promise(resolve => { settle = resolve; deferred.push(resolve); }));
  assert.equal(timed.reason, 'timeout');
  const flightProof = grant(item.inspect(), 'event-in-flight');
  await assert.rejects(item.acknowledgeUnknown(timed.operationId, flightProof, () => true), /not finished cleanup|locked/i);
  settle({ outcome: 'known', value: true }); await item.drain();
  assert.deepEqual(await item.acknowledgeUnknown(timed.operationId, flightProof, () => true), { outcome: 'acknowledged-unknown' });
  close(item);
  const reopened = open(root);
  const retained = await reopened.run(context('first'), async () => assert.fail('restart replayed'));
  assert.equal(retained.outcome, 'unknown'); assert.equal(retained.operationId, first.operationId); close(reopened);

  // Two separate Node processes cannot both consume the same operation/event.
  {
    const { root: raceRoot, item: race } = await create('concurrent-processes');
    const pending = await uncertain(race, 'concurrent-request');
    const moduleUrl = pathToFileURL(compile('main/desktop/globalDesktopWriteBarrier.ts')).href;
    const script = `
      const {GlobalDesktopWriteBarrier}=await import(process.argv[1]);
      const authority={legacyWritersExcluded:()=>true,legacyAutomaticContinuationsExcluded:()=>true,verifyDelivery:()=>true,
        executorStopped:()=>true,verifyRecovery:()=>true,verifyAbandonedLock:()=>true,verifyUnknownContinuation:()=>"process-event"};
      const barrier=GlobalDesktopWriteBarrier.open(process.argv[2],authority);
      console.log('READY');
      process.stdin.once('data',async()=>{
        try { console.log('RESULT '+JSON.stringify(await barrier.acknowledgeUnknown(process.argv[3],{},()=>true))); }
        catch(error) { console.log('RESULT '+JSON.stringify({error:String(error.message)})); }
        finally { barrier.close(); process.stdin.pause(); }
      });`;
    const start = () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleUrl, raceRoot, pending.operationId],
        { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      children.add(child); child.once('close', () => children.delete(child));
      let output = '', errors = '';
      const ready = new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('READY\n')) resolve(); });
        child.stderr.on('data', chunk => { errors += chunk.toString(); });
        child.once('error', reject);
        child.once('exit', code => { if (!output.includes('READY\n')) reject(new Error(`child exited early: ${code} ${errors}`)); });
      });
      const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => {
          if (code !== 0) return reject(new Error(`child failed: ${code} ${errors}`));
          const line = output.split(/\r?\n/).find(value => value.startsWith('RESULT '));
          if (!line) return reject(new Error('child returned no recovery result'));
          resolve(JSON.parse(line.slice(7)));
        });
      });
      return { child, ready, result };
    };
    const one = start(), two = start();
    await Promise.all([one.ready, two.ready]);
    race.store.db.exec('BEGIN');
    try {
      assert.equal(race.inspect().operationId, pending.operationId);
      one.child.stdin.end('go'); two.child.stdin.end('go');
      const results = await Promise.all([one.result, two.result]);
      assert.equal(results.filter(value => value.outcome === 'acknowledged-unknown').length, 1);
      assert.equal(race.inspect().operationId, pending.operationId, 'a read transaction observes one consistent pre-commit snapshot');
    } finally { race.store.db.exec('ROLLBACK'); }
    assert.equal(race.inspect(), null);
    const prior = await race.run(context('concurrent-request'), async () => assert.fail('concurrent recovery replayed'));
    assert.equal(prior.outcome, 'unknown'); assert.equal(prior.operationId, pending.operationId);
    close(race);
  }

  // Removing the uniqueness guard or corrupting the terminal record cannot silently reopen writes.
  {
    const { root: damagedRoot, item: damaged } = await create('damaged');
    const result = await uncertain(damaged, 'damaged-request');
    await damaged.acknowledgeUnknown(result.operationId, grant(damaged.inspect(), 'damage-event'), () => true);
    const db = new DatabaseSync(dbFile(damagedRoot)); db.exec('DROP INDEX global_desktop_unknown_event'); db.close();
    assert.throws(() => damaged.inspect(), /continuation event index/i); close(damaged);
    assert.throws(() => open(damagedRoot), /continuation event index/i);
  }
  {
    const { root: damagedRoot, item: damaged } = await create('damaged-terminal');
    const result = await uncertain(damaged, 'damaged-terminal-request');
    await damaged.acknowledgeUnknown(result.operationId, grant(damaged.inspect(), 'damage-terminal-event'), () => true);
    const db = new DatabaseSync(dbFile(damagedRoot));
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare("UPDATE global_desktop_history SET resolution='confirmed-applied' WHERE operation_id=?").run(result.operationId); db.close();
    assert.throws(() => damaged.inspect(), /Invalid global desktop action history/i); close(damaged);
    assert.throws(() => open(damagedRoot), /integrity|history/i);
  }
  {
    const { root: damagedRoot, item: damaged } = await create('lost-history');
    const result = await uncertain(damaged, 'lost-history-request');
    await damaged.acknowledgeUnknown(result.operationId, grant(damaged.inspect(), 'lost-history-event'), () => true);
    const db = new DatabaseSync(dbFile(damagedRoot));
    db.prepare('DELETE FROM global_desktop_history WHERE operation_id=?').run(result.operationId); db.close();
    assert.throws(() => damaged.inspect(), /history integrity/i, 'removed terminal request cannot silently be replayed');
    close(damaged); assert.throws(() => open(damagedRoot), /history integrity/i);
  }
  {
    const { root: damagedRoot, item: damaged } = await create('changed-history');
    const result = await uncertain(damaged, 'changed-history-request');
    await damaged.acknowledgeUnknown(result.operationId, grant(damaged.inspect(), 'changed-history-event'), () => true);
    const db = new DatabaseSync(dbFile(damagedRoot));
    db.prepare('UPDATE global_desktop_history SET fingerprint_hash=? WHERE operation_id=?').run('f'.repeat(64), result.operationId); db.close();
    assert.throws(() => damaged.inspect(), /history integrity/i, 'well-formed changes to recorded request data are detected');
    close(damaged); assert.throws(() => open(damagedRoot), /history integrity/i);
  }
  console.log('global unknown continuation: v1 migration, exact trusted events, rollback, locks, restart and replay prevention passed');
} finally {
  for (const child of children) { try { child.kill(); } catch {} }
  for (const resolve of deferred) resolve({ outcome: 'unknown' });
  for (const item of opened) { try { await item.drain(); item.close(); } catch {} }
  removeWorkspaceFixture(temp, 'desktop-unknown-continue-');
}
