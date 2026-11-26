import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-legacy-migration-test-'));
const hash = text => createHash('sha256').update(text).digest('hex');
const snapshot = dir => Object.fromEntries(fs.readdirSync(dir).sort().filter(name => fs.statSync(path.join(dir, name)).isFile())
  .map(name => [name, hash(fs.readFileSync(path.join(dir, name)))]));
const table = `CREATE TABLE desktop_action_receipts (
  request_hash TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT)`;
let openDb;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { transitionFromLegacyDesktop, LegacyDesktopTransitionError } = await import(pathToFileURL(compile('main/desktop/legacyDesktopMigration.ts')));
  const { DesktopDispatchJournal } = await import(pathToFileURL(compile('main/desktop/dispatchJournal.ts')));
  const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
  const { DesktopTaskLock } = await import(pathToFileURL(compile('main/desktop/taskLock.ts')));
  const fence = { isQuiescent: () => true };
  const check = async (dir, guard = fence) => {
    let activated = 0;
    const result = await transitionFromLegacyDesktop(dir, guard, async () => { activated++; return 'ready'; });
    return { result, activated };
  };
  const codes = result => result.issues.map(issue => issue.code);

  // New installations and empty, settled old stores activate without approval.
  {
    const absent = await check(path.join(temp, 'absent'));
    assert.deepEqual(absent, { result: { status: 'activated', value: 'ready' }, activated: 1 });
    const root = path.join(temp, 'settled');
    const store = new DesktopActionIdempotency(root);
    await store.run('old-session', 'old-task', 'done', { action: 'click' }, () => true,
      async mark => { mark(); return { outcome: 'dispatched', value: { dispatched: true } }; });
    store.close();
    const journal = new DesktopDispatchJournal(path.join(root, 'dispatch'));
    await journal.recordRefusal('old-task', 'old-scope');
    const before = snapshot(root);
    const settled = await check(root);
    assert.equal(settled.result.status, 'activated');
    assert.equal(settled.activated, 1);
    assert.deepEqual(snapshot(root), before, 'the original receipt files must not be touched');
    assert.equal(await journal.hasRefusal('old-task', 'old-scope'), true);
  }

  // A marker under any old task is globally blocking and remains unchanged.
  {
    const root = path.join(temp, 'journal');
    const journal = new DesktopDispatchJournal(path.join(root, 'dispatch'));
    const marker = await journal.begin('old-task-unrelated-to-new-task', { appId: 'app', surfaceId: 'surface', action: 'click' });
    const before = snapshot(path.join(root, 'dispatch'));
    const { result, activated } = await check(root);
    assert.equal(result.status, 'blocked'); assert.equal(activated, 0);
    assert.ok(codes(result).includes('pending_dispatch'));
    assert.equal(result.issues.find(issue => issue.code === 'pending_dispatch').digest, hash('old-task-unrelated-to-new-task'));
    assert.deepEqual(await journal.read('old-task-unrelated-to-new-task'), marker);
    assert.deepEqual(snapshot(path.join(root, 'dispatch')), before);
  }

  // Actual old pending and completed-unknown receipts both block, even without a journal.
  {
    const root = path.join(temp, 'receipts');
    const store = new DesktopActionIdempotency(root);
    await assert.rejects(store.run('old-session', 'old-task', 'pending', { action: 'click' }, () => true,
      async mark => { mark(); throw new Error('connection lost'); }));
    await store.run('different-session', 'different-task', 'unknown', { action: 'type' }, () => true,
      async mark => { mark(); return { outcome: 'unknown', reason: 'uncertain' }; });
    store.close();
    const before = snapshot(root);
    const { result, activated } = await check(root);
    assert.equal(result.status, 'blocked'); assert.equal(activated, 0);
    assert.ok(codes(result).includes('pending_receipt'));
    assert.ok(codes(result).includes('unknown_receipt'));
    assert.deepEqual(snapshot(root), before);
  }

  // Committed records present only in WAL must be inspected without touching any original sidecar.
  {
    const root = path.join(temp, 'wal'); fs.mkdirSync(root);
    const file = path.join(root, 'action-receipts.sqlite');
    openDb = new DatabaseSync(file);
    openDb.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ${table}; PRAGMA wal_checkpoint(TRUNCATE)`);
    openDb.prepare('INSERT INTO desktop_action_receipts VALUES (?, ?, ?, ?)')
      .run(hash('wal-row'), hash('request'), 'completed', '{"outcome":"unknown"}');
    assert.ok(fs.statSync(`${file}-wal`).size > 0);
    const before = snapshot(root);
    const { result, activated } = await check(root);
    assert.equal(result.status, 'blocked'); assert.equal(activated, 0);
    assert.ok(codes(result).includes('unknown_receipt'), 'committed WAL rows must not be ignored');
    assert.deepEqual(snapshot(root), before, 'SQLite reads only private copies, including WAL');
    assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.legacy-inspection-')), 'the private copy is removed after inspection');
    openDb.close(); openDb = undefined;
  }

  // Stale lock files cannot be declared safe from PID/age, and are never deleted.
  for (const kind of ['locks', 'receipt-locks']) {
    const root = path.join(temp, `lock-${kind}`), dir = path.join(root, kind);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${hash('old-lock')}.lock`);
    fs.writeFileSync(file, '{"version":1,"pid":1,"createdAt":0}');
    const before = fs.readFileSync(file);
    const { result, activated } = await check(root);
    assert.equal(result.status, 'blocked'); assert.equal(activated, 0);
    assert.ok(codes(result).includes('legacy_lock'));
    assert.deepEqual(fs.readFileSync(file), before);
  }
  {
    const root = path.join(temp, 'actual-lock');
    const lock = new DesktopTaskLock(path.join(root, 'locks'));
    const release = await lock.acquire('old-task');
    const blocked = await check(root);
    assert.ok(codes(blocked.result).includes('legacy_lock'));
    await release();
    assert.equal((await check(root)).result.status, 'activated');
  }

  // Malformed markers, unknown entries, corrupt databases and orphan WAL fail closed.
  {
    const root = path.join(temp, 'bad-marker'), dir = path.join(root, 'dispatch'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${hash('bad')}.json`), '{');
    fs.writeFileSync(path.join(dir, 'unexpected.txt'), 'unexpected');
    const { result, activated } = await check(root);
    assert.equal(result.status, 'blocked'); assert.equal(activated, 0);
    assert.equal(result.issues.filter(issue => issue.code === 'corrupt_record').length, 2);
  }
  {
    const root = path.join(temp, 'bad-db'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'action-receipts.sqlite'), 'not sqlite');
    const { result, activated } = await check(root);
    assert.equal(result.status, 'blocked'); assert.equal(activated, 0);
    assert.ok(codes(result).includes('unreadable_storage'));
    assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.legacy-inspection-')), 'failed inspection also cleans up its private copy');
  }
  {
    const root = path.join(temp, 'orphan'); fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'action-receipts.sqlite-wal'), 'orphan');
    const { result, activated } = await check(root);
    assert.equal(result.status, 'blocked'); assert.equal(activated, 0);
    assert.ok(codes(result).includes('corrupt_record'));
  }
  {
    const root = path.join(temp, 'linked'), destination = path.join(temp, 'link-target');
    fs.mkdirSync(root); fs.mkdirSync(destination);
    fs.symlinkSync(destination, path.join(root, 'dispatch'), process.platform === 'win32' ? 'junction' : 'dir');
    const { result, activated } = await check(root);
    assert.equal(result.status, 'blocked'); assert.equal(activated, 0);
    assert.ok(codes(result).includes('corrupt_record'));
  }
  {
    const root = path.join(temp, 'bad-row'); fs.mkdirSync(root);
    const db = new DatabaseSync(path.join(root, 'action-receipts.sqlite'));
    db.exec(table);
    db.prepare('INSERT INTO desktop_action_receipts VALUES (?, ?, ?, ?)')
      .run(hash('row'), hash('request'), 'completed', '{"outcome":"invalid"}');
    db.close();
    const { result } = await check(root);
    assert.ok(codes(result).includes('corrupt_record'));
  }

  // Inspection and diagnostics are bounded; reaching a limit never activates.
  {
    const root = path.join(temp, 'many'); fs.mkdirSync(root);
    const db = new DatabaseSync(path.join(root, 'action-receipts.sqlite'));
    db.exec(`${table}; BEGIN`);
    const insert = db.prepare('INSERT INTO desktop_action_receipts VALUES (?, ?, ?, NULL)');
    for (let i = 0; i < 10001; i++) insert.run(hash(String(i)), hash('request'), 'pending');
    db.exec('COMMIT'); db.close();
    const { result, activated } = await check(root);
    assert.equal(result.status, 'blocked'); assert.equal(activated, 0);
    assert.equal(result.issues.length, 32);
    assert.equal(result.totalIssues, 10001);
  }

  // A missing/lost fence blocks; loss during activation has an explicitly unknown outcome.
  {
    let calls = 0;
    const lost = await check(path.join(temp, 'absent'), { isQuiescent: () => ++calls < 2 });
    assert.equal(lost.result.status, 'blocked'); assert.equal(lost.activated, 0);
    assert.ok(codes(lost.result).includes('quiescence_lost'));
    await assert.rejects(transitionFromLegacyDesktop(path.join(temp, 'absent'), null, async () => {}), /quiescence fence/);
    let held = true;
    await assert.rejects(transitionFromLegacyDesktop(path.join(temp, 'absent'), { isQuiescent: () => held }, async () => {
      held = false; return 'possibly activated';
    }), LegacyDesktopTransitionError);
  }

  console.log('legacy desktop migration: global old records, WAL, locks, corruption, bounds and quiescence passed');
} finally {
  openDb?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
