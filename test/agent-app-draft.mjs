import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.realpathSync(os.tmpdir());
const folder = fs.mkdtempSync(path.join(tempRoot, 'agent-app-draft-'));
if (path.dirname(fs.realpathSync(folder)) !== tempRoot) throw new Error('Unexpected test directory');
try {
  const bundle = path.join(folder, 'draft.cjs');
  buildSync({ entryPoints: [path.join(root, 'src/main/agentApps/draft.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { produceAppDraft } = createRequire(import.meta.url)(bundle);
  const original = { records: { notes: [{ id: 'one', values: { text: 'old' } }, { id: 'two', values: { text: 'stay' } }], other: [{ id: 'three', values: { text: 'other' } }] }, receipts: [{ id: 'a' }, { id: 'b' }], extra: { enabled: true } };
  const { next, result } = produceAppDraft(original, state => {
    const changed = state.records.notes.find(row => row.id === 'one');
    changed.values.text = 'new';
    state.records.notes.push({ id: 'four', values: { text: 'added' } });
    const keep = new Set(state.receipts.filter(item => item.id === 'a'));
    state.receipts = state.receipts.filter(item => keep.has(item));
    delete state.extra.enabled;
    return { record: changed, all: state.records.notes.filter(row => row.id !== 'two') };
  });
  assert.equal(original.records.notes[0].values.text, 'old');
  assert.equal(original.records.notes.length, 2);
  assert.equal(next.records.notes[0].values.text, 'new');
  assert.equal(next.records.notes[2].id, 'four');
  assert.equal(next.records.other, original.records.other, 'unchanged app records are shared, not cloned');
  assert.equal(next.records.notes[1], original.records.notes[1], 'unchanged records are shared');
  assert.deepEqual(next.receipts, [{ id: 'a' }]);
  assert.deepEqual(next.extra, {});
  assert.deepEqual(structuredClone(result), { record: next.records.notes[0], all: [next.records.notes[0], next.records.notes[2]] });
  assert.throws(() => produceAppDraft(original, state => { state.records.notes[0].values.text = 'failed'; throw new Error('fail'); }), /fail/);
  assert.equal(original.records.notes[0].values.text, 'old', 'failed transactions do not mutate their input');
  const detached = produceAppDraft(original, state => {
    const removed = state.records.notes[0];
    state.records.notes = [];
    removed.values.text = 'detached';
  });
  assert.deepEqual(detached.next.records.notes, [], 'mutating an earlier reference cannot restore a replaced collection');
  const spliced = produceAppDraft(original, state => {
    state.records.notes.splice(0, 1);
    state.records.notes[0].values.text = 'changed remaining';
    assert.equal(Object.keys(state.records.notes).length, 1);
  });
  assert.equal(spliced.next.records.notes.length, 1);
  assert.equal(spliced.next.records.notes[0].values.text, 'changed remaining');
  const rewritten = produceAppDraft({ jobs: [{ id: 'first', params: { target: 'one' } }] }, state => {
    state.jobs = state.jobs.filter(job => job.id !== 'second');
    state.jobs.push({ id: 'second', params: { target: 'two' } });
  });
  assert.deepEqual(structuredClone(rewritten.next), { jobs: [{ id: 'first', params: { target: 'one' } }, { id: 'second', params: { target: 'two' } }] }, 'replacing an array then pushing cannot retain proxies');
  let unrelatedLoads = 0;
  const lazyRecords = { tasks: [{ id: 'a', values: { title: 'old' } }] };
  Object.defineProperty(lazyRecords, 'rss', { enumerable: true, configurable: true, get() { unrelatedLoads++; return [{ id: 'b' }]; } });
  const lazyBase = { records: lazyRecords };
  const lazyNext = produceAppDraft(lazyBase, state => { state.records.tasks[0].values.title = 'new'; }).next;
  assert.equal(unrelatedLoads, 0, 'a write to one app must not materialize another app’s records');
  assert.equal(lazyBase.records.tasks[0].values.title, 'old');
  assert.equal(lazyNext.records.tasks[0].values.title, 'new');
  console.log('agent app draft: copy-on-write, array operations, results and rollback passed');
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}
