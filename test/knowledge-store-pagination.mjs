import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-knowledge-page-'));
const compile = createSharedCompiler(process.cwd(), path.join(root, 'compiled'));
const { KnowledgeStore } = await import(pathToFileURL(compile('main/memory/knowledgeStore.ts')));
const store = new KnowledgeStore(path.join(root, 'knowledge'));
const evidence = (id) => ({ namespace: 'worker', origin: 'user', explicit: true, now: 1,
  evidence: [{ id, source: 'pagination-test', eventTime: 1, verification: 'user_confirmed' }] });
try {
  for (const [summary, now] of [['新记录', 30], ['中间记录', 20], ['旧记录', 10]]) {
    store.submit({ kind: 'stable_constraint', summary, applicability: [] }, { ...evidence(summary), now });
  }
  const first = store.listPage({ namespace: 'worker', limit: 2 });
  assert.equal(first.totalCount, 3, 'count is computed in SQLite independently of page size');
  assert.deepEqual(first.records.map(record => record.summary), ['新记录', '中间记录']);
  const cursor = first.records.at(-1);
  const second = store.listPage({ namespace: 'worker', limit: 2, after: { updatedAt: cursor.updatedAt, id: cursor.id } });
  assert.equal(second.totalCount, 3, 'totalCount remains the full filtered set on continuation pages');
  assert.deepEqual(second.records.map(record => record.summary), ['旧记录']);
  assert.equal(new Set([...first.records, ...second.records].map(record => record.id)).size, 3, 'keyset pages do not overlap');
  const filtered = store.listPage({ namespace: 'worker', updatedAfter: 10, updatedBefore: 20, limit: 10 });
  assert.deepEqual(filtered.records.map(record => record.summary), ['中间记录']);
  console.log('knowledge-store-pagination: bounded SQLite keyset pages and filters passed');
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
