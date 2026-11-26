import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-audit-'));
let store;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { DesktopAuditStore } = await import(pathToFileURL(compile('main/desktop/auditStore.ts')));
  const { DesktopActionGate } = await import(pathToFileURL(compile('main/desktop/actionGate.ts')));
  const { DesktopAuthority } = await import(pathToFileURL(compile('main/desktop/authority.ts')));
  const { DesktopUnknownState } = await import(pathToFileURL(compile('main/desktop/unknownState.ts')));
  const { UnknownActionChains } = await import(pathToFileURL(compile('main/desktop/unknownActionChain.ts')));
  const { DesktopDispatchJournal } = await import(pathToFileURL(compile('main/desktop/dispatchJournal.ts')));
  const { DesktopTaskLock } = await import(pathToFileURL(compile('main/desktop/taskLock.ts')));
  const legacyFile = path.join(temp, 'legacy.sqlite'), legacy = new DatabaseSync(legacyFile);
  legacy.exec(`CREATE TABLE desktop_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, session_hash TEXT NOT NULL, task_hash TEXT NOT NULL, source TEXT NOT NULL, action TEXT NOT NULL,
    stage TEXT NOT NULL, result TEXT NOT NULL, app_hash TEXT, surface_hash TEXT, evidence_hash TEXT, object_hash TEXT)`);
  legacy.prepare('INSERT INTO desktop_audit(id,created_at,session_hash,task_hash,source,action,stage,result) VALUES (?,?,?,?,?,?,?,?)').run('old-denied',1,createHash('sha256').update('old').digest('hex'),'old-task','desktop','move','approval','denied');
  legacy.close();
  const migrated = new DesktopAuditStore(legacyFile, () => 1);
  assert.equal(migrated.list('old')[0].result, 'denied');
  assert.equal(migrated.list('old')[0].refusal_reason, null);
  migrated.append({ sessionId: 'old', taskId: 'task', source: 'browser', action: 'click', stage: 'reconciliation', result: 'allowed', resolution: 'abandoned' });
  assert.equal(migrated.list('old')[1].resolution, 'abandoned');
  migrated.append({ sessionId: 'old', taskId: 'task', source: 'desktop', action: 'move', stage: 'approval', result: 'denied', refusalReason: 'confirmation-unavailable' });
  assert.equal(migrated.list('old')[2].refusal_reason, 'confirmation-unavailable'); migrated.close();
  const file = path.join(temp, 'audit.sqlite'); store = new DesktopAuditStore(file, () => 100);
  const base = { sessionId: 'private-session', taskId: 'private-task', source: 'desktop', action: 'click', stage: 'approval', result: 'allowed',
    appId: 'private-application', surfaceId: 'private-surface', evidenceSha256: 'a'.repeat(64) };
  const first = store.append(base), second = store.append({ ...base, result: 'denied' });
  assert.equal(second.sequence, first.sequence + 1);
  assert.equal(store.list('other-session').length, 0);
  assert.equal(store.list('private-session', first.sequence).length, 1);
  assert.doesNotMatch(JSON.stringify(store.list('private-session')), /private-session|private-task|private-application|private-surface/);
  assert.throws(() => store.append({ ...base, inputText: 'secret' }), /Invalid/);
  assert.throws(() => store.append({ ...base, action: 'secret' }), /Invalid/);
  assert.throws(() => store.append({ ...base, evidenceSha256: 'secret' }), /Invalid/);
  assert.throws(() => store.append({ ...base, resolution: 'abandoned' }), /Invalid/, 'resolution is only valid in reconciliation');
  assert.throws(() => store.append({ ...base, refusalReason: 'user-declined' }), /Invalid/, 'refusal reason requires denied approval');
  assert.throws(() => store.append({ ...base, result: 'denied', refusalReason: 'arbitrary text' }), /Invalid/);
  assert.throws(() => store.list('private-session', 0, 501), /Invalid/);
  store.close(); store = new DesktopAuditStore(file, () => 101);
  assert.equal(store.list('private-session').length, 2, 'audit records survive store recreation');
  const auditStore = store;
  const journal = new DesktopDispatchJournal(path.join(temp, 'journal'));
  const authority = new DesktopAuthority({ unknownState: new DesktopUnknownState(), actions: ['click'], grantTtlMs: 10000, journal,
    confirmApplication: async () => true, confirmObject: async () => true,
    audit: async event => { auditStore.append({ ...base, stage: event.stage === 'application-approval' ? 'approval' : event.stage,
      result: event.result }); } });
  const gate = new DesktopActionGate(authority, new UnknownActionChains(journal), async () => true,
    async (_boundary, decision) => { auditStore.append({ ...base, stage: decision === 'attempt' ? 'dispatch-intent' : 'approval', result: 'allowed' }); },
    new DesktopTaskLock(path.join(temp, 'lock')), async () => () => true);
  const boundary = { taskId: 'private-task', appId: 'private-application', processInstance: 'process', surfaceId: 'private-surface',
    surfaceGeneration: 'generation', captureId: 'capture', geometryRevision: 'geometry', region: { x: 0, y: 0, width: 1, height: 1 },
    actionClass: 'click', evidenceSha256: 'a'.repeat(64) };
  const request = { taskId: boundary.taskId, target: { appId: boundary.appId, processInstance: boundary.processInstance,
    surfaceId: boundary.surfaceId, surfaceGeneration: boundary.surfaceGeneration }, action: 'click', foreground: false };
  let dispatched = 0;
  assert.equal((await gate.runUnknown(request, boundary, () => true, async () => ++dispatched)).outcome, 'dispatched');
  store.close(); store = undefined;
  await assert.rejects(gate.runUnknown(request, boundary, () => true, async () => ++dispatched));
  assert.equal(dispatched, 1, 'audit storage failure must stop the next dispatch');
  console.log('desktop audit: durable scoped records, no free text and audit failure blocks dispatch');
} finally {
  store?.close();
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('desktop-audit-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
