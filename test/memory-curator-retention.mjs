import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const scratch = path.resolve('.tmp'); fs.mkdirSync(scratch, { recursive: true });
const temp = fs.mkdtempSync(path.join(scratch, 'memory-curator-retention-'));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const { KnowledgeStore, encodeKnowledge } = await import(pathToFileURL(compile('main/memory/knowledgeStore.ts')));
const { KnowledgePipeline } = await import(pathToFileURL(compile('main/memory/knowledgePipeline.ts')));
const { pruneCuratorRetention } = await import(pathToFileURL(compile('main/memory/curatorRetention.ts')));
const DAY = 86_400_000, observedAt = Date.now(), now = observedAt + 100 * DAY;
const hash = text => createHash('sha256').update(text).digest('hex');
const stores = [], guards = [];
let serial = 0;
function fixture(name) { const store = new KnowledgeStore(path.join(temp, name)); stores.push(store); return store; }
function fact(store, extra = {}) {
  const id = `fact-event:${++serial}`;
  return store.submit({ kind: 'task_fact', summary: `过期任务事实 ${serial}`, taskId: `task:${serial}`, applicability: [], ...extra },
    { namespace: 'worker', origin: 'worker', now: observedAt, evidence: [{ id, source: 'fixture-host', eventTime: observedAt, verification: 'unverified' }] }).record;
}
function source(store, name, extra = {}) {
  const pipeline = new KnowledgePipeline(store);
  const event = { id: name, text: '原始事件正文；完成行为不等于验证结果。', namespace: 'worker', origin: 'user',
    evidence: { id: name, source: 'fixture-original', eventTime: store.startedAt + 1, verification: 'user_confirmed' }, ...extra };
  assert.equal(pipeline.enqueue(event), true);
  store.db.prepare("UPDATE source_events SET state='done',created_at=? WHERE id=?").run(observedAt, name);
  return { event, pipeline };
}
const options = { now, maxDurationMs: 1000, maxRecords: 100, maxEvents: 100 };
const count = (store, table) => Number(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
const payload = (store, id) => store.db.prepare('SELECT payload FROM records WHERE id=?').get(id)?.payload;

try {
  {
    const store = fixture('unreferenced'), expired = fact(store), original = payload(store, expired.id);
    const fresh = fact(store, { expiresAt: now + DAY });
    assert.equal(expired.expiresAt, observedAt + 90 * DAY, 'task facts keep the established ninety-day default');
    const result = pruneCuratorRetention(store, options);
    assert.deepEqual(result.records, [expired.id]); assert.equal(payload(store, expired.id), undefined);
    assert.equal(store.db.prepare('SELECT 1 FROM knowledge_hot WHERE id=?').get(expired.id), undefined, 'retention removes the derived hot projection with the canonical record');
    assert.ok(payload(store, fresh.id));
    const receipt = JSON.parse(store.db.prepare("SELECT payload FROM curator_retention WHERE kind='record' AND id=?").get(expired.id).payload);
    assert.equal(receipt.id, expired.id); assert.equal(receipt.payloadHash, hash(original));
    assert.equal(receipt.summary, undefined); assert.equal(receipt.evidence[0].id, expired.evidence[0].id);
    assert.equal(pruneCuratorRetention(store, options).records.length, 0, 'maintenance is idempotent');
  }
  {
    const store = fixture('dependencies');
    const version = fact(store), linked = fact(store), deleted = fact(store), audited = fact(store), curated = fact(store), pending = fact(store), checkpoint = fact(store), legacy = fact(store);
    store.db.prepare('INSERT INTO versions VALUES(?,?,?)').run(version.id, version.revision, JSON.stringify(version));
    const effective = store.submit({ kind: 'stable_constraint', summary: '持续保留关联证据', applicability: [] },
      { namespace: 'worker', origin: 'user', explicit: true, evidence: [{ id: linked.id, source: 'host', eventTime: observedAt, verification: 'user_confirmed' }] }).record;
    store.db.prepare('INSERT INTO relations VALUES(?,?,?,?)').run(effective.id, linked.id, 'supports', 0);
    const deletion = JSON.stringify({ ...deleted, deletedAt: observedAt });
    store.db.prepare('INSERT INTO knowledge_deleted VALUES(?,?)').run(deleted.id, deletion);
    const governance = [JSON.stringify({ id: 'governance-1', recordId: audited.id, undone: false }), JSON.stringify([audited]), JSON.stringify([audited])];
    store.db.prepare('INSERT INTO governance VALUES(?,?,?,?)').run('governance-1', ...governance);
    const curator = [JSON.stringify({ candidateId: 'receipt-candidate', affected: [{ id: curated.id, revision: 1 }], record: curated }), '[]', JSON.stringify([curated])];
    store.db.prepare('INSERT INTO curator_receipts VALUES(?,?,?,?,?)').run('operation-1', 'immutable-signature', ...curator);
    source(store, 'unfinished-source', { text: '未完成恢复', target: pending.id });
    store.db.prepare("UPDATE source_events SET state='failed',prepared=? WHERE id='unfinished-source'").run(JSON.stringify({ record: pending }));
    store.setCheckpoint('recover:explicit', JSON.stringify({ targetId: checkpoint.id }));
    store.db.prepare('DELETE FROM record_storage WHERE id=?').run(legacy.id);
    fs.writeFileSync(path.join(store.assetsDir, `${legacy.id}.md`), encodeKnowledge(legacy), 'utf8');
    const result = pruneCuratorRetention(store, options);
    assert.equal(result.records.length, 0, 'all recovery and audit dependencies remain intact');
    for (const item of [version, linked, deleted, audited, curated, pending, checkpoint, legacy]) assert.ok(payload(store, item.id));
    assert.equal(store.db.prepare('SELECT payload FROM versions WHERE id=?').get(version.id).payload, JSON.stringify(version));
    assert.equal(store.db.prepare('SELECT payload FROM knowledge_deleted WHERE id=?').get(deleted.id).payload, deletion);
    assert.deepEqual(Object.values(store.db.prepare('SELECT receipt,before_json,after_json FROM governance').get()), governance);
    assert.deepEqual(Object.values(store.db.prepare('SELECT receipt,before_json,after_json FROM curator_receipts').get()), curator);
    assert.equal(fs.readFileSync(path.join(store.assetsDir, `${legacy.id}.md`), 'utf8'), encodeKnowledge(legacy), 'retention does not remove projected records');
  }
  {
    const store = fixture('source-payload'), quote = '保留这个逐字证据摘录。';
    const { event, pipeline } = source(store, 'completed-source', { text: `${quote}\n${'obsolete body '.repeat(500)}` });
    const original = store.db.prepare('SELECT payload,hash FROM source_events WHERE id=?').get(event.id);
    const prepared = JSON.stringify({ records: [{ summary: 'old prepared full body' }] }), extracted = JSON.stringify({ records: [{ summary: 'old extracted full body' }] });
    const review = [{ index: 0, verdict: 'keep', sourceQuote: quote, reason: '原始来源支持', existingId: undefined }];
    store.db.prepare('UPDATE source_events SET prepared=?,extracted=?,timings=? WHERE id=?').run(prepared, extracted, JSON.stringify([{ stage: 'review', error: 'old detail' }]), event.id);
    store.setCheckpoint(`review:${event.id}`, JSON.stringify(review)); store.setCheckpoint('independent_state', 'preserve independent configuration state');
    const active = store.submit({ kind: 'stable_constraint', summary: '持续保留证据身份', applicability: [] },
      { namespace: 'worker', origin: 'user', explicit: true, evidence: [{ ...event.evidence, contentHash: hash(event.text), excerpt: quote }] }).record;
    const untouched = {};
    for (const state of ['pending', 'failed', 'running']) {
      const item = source(store, `recovery-${state}`);
      store.db.prepare('UPDATE source_events SET state=?,prepared=?,extracted=?,lease_until=? WHERE id=?').run(state, prepared, extracted, state === 'running' ? now - 1 : null, item.event.id);
      untouched[item.event.id] = store.db.prepare('SELECT * FROM source_events WHERE id=?').get(item.event.id);
    }
    const result = pruneCuratorRetention(store, { ...options, maxRecords: 0 }); assert.deepEqual(result.events, [event.id]);
    const retired = store.db.prepare('SELECT * FROM source_events WHERE id=?').get(event.id);
    assert.equal(retired.hash, original.hash); assert.equal(retired.state, 'done'); assert.equal(JSON.parse(retired.payload).text, '');
    assert.equal(retired.prepared, null); assert.equal(retired.extracted, null); assert.equal(retired.timings, null);
    assert.equal(store.checkpoint(`review:${event.id}`), undefined); assert.equal(store.checkpoint('independent_state'), 'preserve independent configuration state');
    const receipt = JSON.parse(store.db.prepare("SELECT payload FROM curator_retention WHERE kind='event' AND id=?").get(event.id).payload);
    assert.equal(receipt.hash, original.hash); assert.equal(receipt.payloadHash, hash(original.payload)); assert.equal(receipt.preparedHash, hash(prepared));
    assert.deepEqual(receipt.review, JSON.parse(JSON.stringify(review))); assert.equal(receipt.excerpts[0].excerpt, quote); assert.equal(receipt.references[0].id, active.id);
    assert.equal(JSON.stringify(receipt).includes('obsolete body'), false, 'the audit receipt stores necessary quotes and hashes, not the complete event');
    assert.equal(pipeline.enqueue(event), false, 'same event identity cannot replay after body retirement');
    assert.throws(() => pipeline.enqueue({ ...event, text: 'changed event contents' }), /同一事件身份/);
    for (const [id, before] of Object.entries(untouched)) assert.deepEqual(store.db.prepare('SELECT * FROM source_events WHERE id=?').get(id), before, 'unfinished/failed recovery payload is preserved');
  }
  {
    const store = fixture('atomic'), first = fact(store), second = fact(store);
    let checks = 0;
    assert.throws(() => pruneCuratorRetention(store, { ...options, assertIdle() { if (++checks === 3) throw new Error('maintenance interrupted'); } }), /maintenance interrupted/);
    assert.ok(payload(store, first.id)); assert.ok(payload(store, second.id));
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='curator_retention'").get(), undefined, 'DDL, deletion and progress roll back together');
    const batch = pruneCuratorRetention(store, { ...options, maxRecords: 1 }); assert.equal(batch.records.length, 1);
    const again = pruneCuratorRetention(store, { ...options, maxRecords: 1 }); assert.equal(again.records.length, 1);
    assert.notEqual(batch.records[0], again.records[0]); assert.equal(count(store, 'curator_retention'), 2);
    const directory = store.directory; store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new KnowledgeStore(directory); stores.push(reopened); assert.equal(reopened.list().records.length, 0, 'retired history does not reappear on reopen');
  }
  {
    const store = fixture('retention-budget'), first = fact(store), second = fact(store);
    const boundedBatch = pruneCuratorRetention(store, { ...options, maxRetentionEntries: 1 });
    const ordered = [first.id, second.id].sort();
    assert.deepEqual(boundedBatch.records, [ordered[0]], 'a bounded audit batch still commits the entry that fits');
    assert.equal(boundedBatch.blocked, 'retention-budget', 'the physical audit bound is visible instead of silently growing');
    assert.ok(payload(store, ordered[1]), 'the entry that did not fit remains canonical and retryable');
    assert.equal(count(store, 'curator_retention'), 1);
    const resumed = pruneCuratorRetention(store, { ...options, maxRetentionEntries: 2 });
    assert.deepEqual(resumed.records, [ordered[1]], 'raising the configured bound resumes from the durable cursor');
    assert.equal(count(store, 'curator_retention'), 2);
    store.db.prepare('INSERT INTO events(record_id,kind,at,detail) VALUES(?,?,?,?)').run(null, 'old_activity', now - 91 * DAY, 'old');
    store.db.prepare('INSERT INTO events(record_id,kind,at,detail) VALUES(?,?,?,?)').run(null, 'recent_activity', now - DAY, 'recent');
    const compacted = pruneCuratorRetention(store, { ...options, maxRecords: 0, maxEvents: 0, maxActivityEventRows: 1 });
    assert.equal(compacted.compactedActivityEvents, 1, 'disposable activity rows are reclaimed in a bounded batch');
    assert.equal(count(store, 'events'), 1);
    fact(store);
    const blockedByBytes = pruneCuratorRetention(store, { ...options, maxRetentionBytes: 1 });
    assert.equal(blockedByBytes.blocked, 'retention-budget');
  }
  {
    const store = fixture('guards'), expired = fact(store), guard = new DatabaseSync(':memory:'); guards.push(guard);
    guard.exec('CREATE TABLE leases(name TEXT PRIMARY KEY,owner TEXT,expires INTEGER); CREATE TABLE candidates(id TEXT PRIMARY KEY,payload TEXT,state TEXT,lease_until INTEGER)');
    guard.prepare('INSERT INTO leases VALUES(?,?,?)').run('processor', 'other-process', now + DAY);
    assert.equal(pruneCuratorRetention(store, { ...options, guardDatabases: [guard] }).blocked, 'active-lease'); assert.ok(payload(store, expired.id));
    guard.exec('DELETE FROM leases'); guard.prepare("INSERT INTO candidates VALUES(?,?,'running',?)").run('job', '{}', now + DAY);
    assert.equal(pruneCuratorRetention(store, { ...options, guardDatabases: [guard] }).blocked, 'active-curator-claim');
    guard.exec('DELETE FROM candidates'); guard.prepare("INSERT INTO candidates VALUES(?,?,'pending',NULL)").run('resume', JSON.stringify({ evidence: [{ recordId: expired.id }] }));
    assert.equal(pruneCuratorRetention(store, { ...options, guardDatabases: [guard] }).records.length, 0, 'unclaimed durable jobs may still require the record');
    guard.exec('DELETE FROM candidates');
    const leaseSource = source(store, 'active-source');
    store.db.prepare("UPDATE source_events SET state='running',claim='worker',lease_until=? WHERE id=?").run(now + DAY, leaseSource.event.id);
    assert.equal(pruneCuratorRetention(store, options).blocked, 'active-source-claim');
    store.db.prepare("UPDATE source_events SET state='done',claim=NULL,lease_until=NULL WHERE id=?").run(leaseSource.event.id);
    store.db.prepare('INSERT INTO outbox VALUES(?,?,?)').run(expired.id, JSON.stringify(expired), 'pending-hash');
    assert.equal(pruneCuratorRetention(store, options).blocked, 'projection-recovery'); store.db.exec('DELETE FROM outbox');
    assert.deepEqual(pruneCuratorRetention(store, { ...options, guardDatabases: [guard] }).records, [expired.id]);
  }
  {
    const store=fixture('busy-guard'),expired=fact(store),other=new DatabaseSync(path.join(store.ledgerDirectory,'knowledge.sqlite'));guards.push(other);
    store.db.exec('PRAGMA busy_timeout=5000');other.exec('BEGIN IMMEDIATE');
    const started=Date.now();
    try{assert.equal(pruneCuratorRetention(store,options).blocked,'database-busy');}
    finally{other.exec('ROLLBACK');}
    assert.ok(Date.now()-started<1000,'optional maintenance must not wait five seconds on another writer');
    assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout,5000,'the normal writer timeout is restored after a blocked maintenance');
    assert.ok(payload(store,expired.id));assert.deepEqual(pruneCuratorRetention(store,options).records,[expired.id]);
  }
  console.log('memory-curator-retention: bounded expiry, identity tombstones, dependency/lease guards, nonblocking lock contention, source audit excerpts, atomic interruption and replay fixtures passed');
} finally {
  for (const store of stores) store.close(); for (const guard of guards) guard.close();
  const relative = path.relative(scratch, temp);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'temporary cleanup stays under the workspace scratch directory');
  fs.rmSync(temp, { recursive: true, force: true });
}
