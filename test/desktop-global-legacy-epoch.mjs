import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-global-legacy-'));
let barrier;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopActionIdempotency } = await import(pathToFileURL(compile('main/desktop/actionIdempotency.ts')));
  const { WriteOutbox } = await import(pathToFileURL(compile('main/desktop/writeOutbox.ts')));
  const { DesktopActivity } = await import(pathToFileURL(compile('main/desktop/desktopActivity.ts')));
  const { DesktopTurns } = await import(pathToFileURL(compile('main/desktop/desktopTurns.ts')));
  const barrierModule = compile('main/desktop/globalDesktopWriteBarrier.ts');
  const { GlobalDesktopWriteBarrier } = await import(pathToFileURL(barrierModule));
  const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
    legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyLegacyDelivery: () => false, verifyLegacyResolution: () => false };
  let continuationsExcluded = true;
  const authority = { legacyWritersExcluded: () => true, legacyAutomaticContinuationsExcluded: () => continuationsExcluded,
    verifyDelivery: ({ evidenceId }) => evidenceId === 'engine-proof',
    executorStopped: () => true, verifyRecovery: () => true, verifyAbandonedLock: () => true };
  const shared = path.join(temp, 'global'), oldA = path.join(temp, 'old-a'), oldB = path.join(temp, 'old-b');
  const options = { root: shared, legacyRoots: [oldA, oldB], legacyOutboxes: [], fence };
  const save = async (root, session, task, requestId, value) => {
    const old = new DesktopActionIdempotency(root);
    try { await old.run(session, task, requestId, { action: 'example' }, () => true,
      async mark => { mark(); return { outcome: 'dispatched', value }; }); }
    finally { old.close(); }
  };
  await save(oldA, 'old-session', 'old-task', 'old-click', { dispatched: true });
  await save(oldB, 'old-session', 'old-task', 'old-launch', { pid: 42 });
  const preview = await GlobalDesktopWriteBarrier.previewLegacy(options);
  assert.equal(preview.receiptCount, 2); assert.equal(preview.delivery, 'unverified');
  assert.equal(preview.dispatchCount, 1); assert.equal(preview.launchCount, 1);
  assert.match(preview.manifestHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(preview), /old-session|old-task|old-click|"pid"/);
  await assert.rejects(GlobalDesktopWriteBarrier.activate({ ...options,
    fence: { ...fence, legacyAutomaticContinuationsExcluded: () => false }, authority }), /fence/);
  assert.equal(fs.existsSync(path.join(shared, 'global-desktop-write.sqlite')), false);

  // Preview is diagnostic only. Activation rescans under its fence and imports
  // the current complete set, without asking for any manifest approval.
  await save(oldB, 'old-session', 'old-task', 'later', { dispatched: true });
  barrier = await GlobalDesktopWriteBarrier.activate({ ...options, authority });
  const finalPreview = await GlobalDesktopWriteBarrier.previewLegacy(options);
  assert.equal(finalPreview.receiptCount, 3); assert.equal(finalPreview.dispatchCount, 2); assert.equal(finalPreview.launchCount, 1);
  assert.notEqual(finalPreview.manifestHash, preview.manifestHash);
  const epoch = barrier.inspectLegacyEpoch();
  assert.equal(epoch.receiptCount, 3); assert.equal(epoch.manifestHash, finalPreview.manifestHash); assert.equal(epoch.delivery, 'unverified');
  assert.equal('authorizationHash' in epoch, false, 'migration must not create a fake user authorization');
  const dbFile = path.join(shared, 'global-desktop-write.sqlite');
  const audit = new DatabaseSync(dbFile, { readOnly: true });
  const rows = audit.prepare('SELECT request_hash,fingerprint,result_hash,format,delivery_state FROM global_desktop_legacy_receipts').all();
  const columns = audit.prepare('PRAGMA table_info(global_desktop_legacy_control)').all().map(row => row.name);
  assert.equal(columns.includes('authorization_hash'), false, 'new ledgers contain no fabricated authorization proof');
  assert.equal(rows.length, 3); assert.ok(rows.every(row => row.delivery_state === 'unverified'));
  assert.deepEqual(new Set(rows.map(row => row.format)), new Set(['win32-dispatch-v1', 'win32-launch-v1']));
  assert.doesNotMatch(JSON.stringify(rows), /old-session|old-task|old-click/);
  audit.close();

  const context = (sessionId, taskId, publicRequestId, requestId = 'host-logical-id') => ({ sessionId, taskId, publicRequestId, requestId,
    action: 'click', target: 'window', fingerprint: 'a'.repeat(64), isCurrent: () => true });
  let calls = 0;
  const backend = async () => { calls++; return { outcome: 'known', value: true }; };
  continuationsExcluded = false;
  await assert.rejects(barrier.run(context('automatic-continuation', 'new-task', 'new'), backend), /not durably excluded/);
  continuationsExcluded = true;
  await assert.rejects(barrier.run(context('new-session', 'new-task', undefined), backend), /legacy request identity/);
  await assert.rejects(barrier.run(context('old-session', 'old-task', 'old-click'), backend), /automatic replay/);
  await assert.rejects(barrier.run(context('old-session', 'old-task', 'old-launch'), backend), /automatic replay/);
  assert.equal(calls, 0, 'old identities and automatic continuations cannot dispatch');
  const fresh = context('new-session', 'new-task', 'old-click');
  const result = await barrier.run(fresh, backend);
  assert.equal(result.outcome, 'known'); assert.equal(calls, 1);
  assert.deepEqual(await barrier.acknowledge(fresh, result.operationId, result.deliveryToken, 'engine-proof'), { outcome: 'confirmed' });
  barrier.close(); barrier = GlobalDesktopWriteBarrier.open(shared, authority);
  assert.deepEqual(barrier.inspectLegacyEpoch(), epoch);
  await assert.rejects(barrier.run(context('old-session', 'old-task', 'old-click', 'new-host-id'), backend), /automatic replay/);
  const freshRetry = await barrier.run(fresh, backend);
  assert.equal(freshRetry.outcome, 'unknown');
  assert.equal(freshRetry.reason, 'request-already-recorded');
  assert.equal(freshRetry.operationId, result.operationId);
  assert.equal(calls, 1, 'both legacy and new identities remain protected after restart');

  // The existing stop rule is separate from migration approval. Compose the
  // actual turn lifecycle and SQLite barrier: initial work needs no new prompt,
  // but a stopped run cannot resume via an automatic or pre-stop instruction.
  const activity = new DesktopActivity({ show: async () => {}, close: () => {} }, async () => {}, {});
  const turns = new DesktopTurns(activity);
  const write = (turnId, id) => turns.use('stop-owner', turnId, 'window', async (_signal, lease) => {
    const item = { ...context('stop-owner', 'stop-task', id, `logical-${id}`), isCurrent: lease.isCurrent, signal: lease.signal };
    const value = await barrier.run(item, backend);
    assert.equal(value.outcome, 'known');
    assert.deepEqual(await barrier.acknowledge(item, value.operationId, value.deliveryToken, 'engine-proof'), { outcome: 'confirmed' });
    return value;
  });
  turns.begin('stop-owner', 'before-stop', () => true);
  await write('before-stop', 'before-stop');
  turns.noteUserInstruction('stop-owner', 'queued-before-stop');
  await turns.stop();
  turns.begin('stop-owner', 'automatic', () => true);
  await assert.rejects(write('automatic', 'automatic'), /new user instruction/);
  turns.begin('stop-owner', 'stale-instruction', () => true, true, 'queued-before-stop');
  await assert.rejects(write('stale-instruction', 'stale-instruction'), /predates the latest stop/);
  assert.equal(calls, 2, 'stop blocks old continuations before entering the global backend');
  turns.noteUserInstruction('stop-owner', 'accepted-after-stop');
  turns.begin('stop-owner', 'fresh-instruction', () => true, true, 'accepted-after-stop');
  await write('fresh-instruction', 'fresh-instruction');
  turns.end('stop-owner', 'fresh-instruction');
  assert.equal(calls, 3);
  barrier.close(); barrier = undefined;
  const childScript = `
    import { pathToFileURL } from 'node:url';
    const { GlobalDesktopWriteBarrier } = await import(pathToFileURL(process.argv[1]));
    const authority = { legacyWritersExcluded:()=>true, legacyAutomaticContinuationsExcluded:()=>true, verifyDelivery:()=>true, executorStopped:()=>true,
      verifyRecovery:()=>true, verifyAbandonedLock:()=>true };
    const barrier = GlobalDesktopWriteBarrier.open(process.argv[2], authority);
    let called = false;
    try {
      if (barrier.inspectLegacyEpoch()?.delivery !== 'unverified') throw new Error('legacy delivery state changed');
      await barrier.run({requestId:'child-host-id', publicRequestId:'old-click', sessionId:'old-session', taskId:'old-task',
        action:'click', target:'window', fingerprint:'a'.repeat(64), isCurrent:()=>true}, async()=>{called=true;return {outcome:'known',value:true};});
      throw new Error('old request replayed');
    } catch (error) { if (!/automatic replay/.test(String(error)) || called) throw error; }
    finally { barrier.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript, barrierModule, shared], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const tamper = new DatabaseSync(dbFile);
  tamper.prepare("UPDATE global_desktop_legacy_receipts SET fingerprint=? WHERE rowid=(SELECT rowid FROM global_desktop_legacy_receipts LIMIT 1)").run('f'.repeat(64));
  tamper.close();
  assert.throws(() => GlobalDesktopWriteBarrier.open(shared, authority), /ledger/);

  for (const kind of ['pending', 'unknown', 'unrecognized', 'corrupt']) {
    const root = path.join(temp, `bad-${kind}`);
    const old = new DesktopActionIdempotency(root);
    try {
      if (kind === 'pending') await assert.rejects(old.run('s', 't', 'r', {}, () => true, async mark => { mark(); throw new Error('lost'); }));
      else await old.run('s', 't', 'r', {}, () => true, async mark => { mark(); return kind === 'unknown'
        ? { outcome: 'unknown' } : { outcome: 'dispatched', value: kind === 'corrupt' ? { dispatched: true } : { effect: 'unknown' } }; });
    } finally { old.close(); }
    const oldFile = path.join(root, 'action-receipts.sqlite');
    if (kind === 'corrupt') {
      const db = new DatabaseSync(oldFile); db.prepare('UPDATE desktop_action_receipts SET result=?').run('{invalid'); db.close();
    }
    const original = fs.readFileSync(oldFile);
    await assert.rejects(GlobalDesktopWriteBarrier.previewLegacy({ root, legacyRoots: [], legacyOutboxes: [], fence }), undefined,
      `${kind} legacy receipt must block inspection and cannot be settled by new user intent`);
    await assert.rejects(GlobalDesktopWriteBarrier.activate({ root, legacyRoots: [], legacyOutboxes: [], fence, authority }), undefined,
      `${kind} legacy receipt must block automatic activation`);
    assert.deepEqual(fs.readFileSync(oldFile), original, 'blocked migration must preserve the original receipt database');
    assert.equal(fs.existsSync(path.join(root, 'global-desktop-write.sqlite')), false);
  }
  for (const suffix of ['-journal', '-shm']) {
    const root = path.join(temp, `old-outbox${suffix}`); fs.mkdirSync(root);
    const file = path.join(root, 'outbox.sqlite');
    const outbox = new WriteOutbox(file); outbox.close();
    fs.writeFileSync(`${file}${suffix}`, 'unresolved sidecar');
    await assert.rejects(GlobalDesktopWriteBarrier.previewLegacy({ root, legacyRoots: [], legacyOutboxes: [file], fence }), undefined,
      'rollback journals and orphan shared-memory files must block migration');
    assert.equal(fs.existsSync(path.join(root, 'global-desktop-write.sqlite')), false);
  }
  for (const stopAt of [1, 2, 3, 4, 5]) {
    const root = path.join(temp, `lost-fence-${stopAt}`);
    await save(root, 's', 't', 'r', { dispatched: true });
    const transition = { root, legacyRoots: [], legacyOutboxes: [], fence };
    let checks = 0;
    const expiring = { ...fence, legacyWritersPermanentlyExcluded: () =>
      !fs.existsSync(path.join(root, 'global-desktop-write.sqlite')) || ++checks < stopAt };
    await assert.rejects(GlobalDesktopWriteBarrier.activate({ ...transition, fence: expiring, authority }));
    assert.ok(checks >= stopAt);
    assert.throws(() => GlobalDesktopWriteBarrier.open(root, authority), /not fully activated/,
      'a lost host fence during import or sealing cannot leave an openable barrier');
  }
  console.log('global legacy epoch: automatic import, unverified delivery, stop guard, deduplication and fail-closed recovery passed');
} finally {
  try { barrier?.close(); } catch {}
  removeWorkspaceFixture(temp, 'desktop-global-legacy-');
}
