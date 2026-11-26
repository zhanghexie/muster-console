import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-knowledge-hot-'));
const compile = createSharedCompiler(process.cwd(), path.join(root, 'compiled'));
const { KnowledgeStore } = await import(pathToFileURL(compile('main/memory/knowledgeStore.ts')));
const directory = path.join(root, 'knowledge');
let store = new KnowledgeStore(directory);
const evidence = (id, namespace = 'worker') => ({ namespace, origin: 'user', explicit: true, now: 1,
  evidence: [{ id, source: 'hot-projection-test', eventTime: 1, verification: 'user_confirmed' }] });

try {
  const record = store.submit({ kind: 'stable_constraint', summary: '热投影应保存筛选列', applicability: ['test'],
    repoKey: 'repo-hot', branch: 'main', taskId: 'task-hot', expiresAt: 12345 }, { ...evidence('hot-1'), now: 30 }).record;
  const hot = store.db.prepare('SELECT id,namespace,kind,status,updated_at,created_at,expires_at,repo_key,branch,task_id FROM knowledge_hot WHERE id=?').get(record.id);
  assert.deepEqual({ ...hot }, { id: record.id, namespace: record.namespace, kind: record.kind, status: record.status,
    updated_at: record.updatedAt, created_at: record.createdAt, expires_at: record.expiresAt,
    repo_key: record.repoKey, branch: record.branch, task_id: record.taskId });

  // listPage reads its keyset and filters from the derived columns.
  store.db.prepare('UPDATE knowledge_hot SET updated_at=? WHERE id=?').run(999, record.id);
  assert.deepEqual(store.listPage({ updatedAfter: 900, limit: 10 }).records.map(item => item.id), [record.id]);

  // Reopening repairs stale derived values from canonical records.
  store.close();
  store = new KnowledgeStore(directory);
  const rebuilt = store.db.prepare('SELECT updated_at,created_at,expires_at,repo_key,branch,task_id FROM knowledge_hot WHERE id=?').get(record.id);
  assert.deepEqual({ ...rebuilt }, { updated_at: record.updatedAt, created_at: record.createdAt, expires_at: record.expiresAt,
    repo_key: record.repoKey, branch: record.branch, task_id: record.taskId });

  // A pre-projection database (table absent) is rebuilt on startup without
  // changing the canonical ledger or Markdown projection.
  const canonical = store.db.prepare('SELECT payload FROM records WHERE id=?').get(record.id).payload;
  store.db.exec('DROP TABLE knowledge_hot');
  store.close();
  store = new KnowledgeStore(directory);
  assert.equal(store.db.prepare('SELECT payload FROM records WHERE id=?').get(record.id).payload, canonical);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM knowledge_hot WHERE id=?').get(record.id).n, 1);
  assert.deepEqual(store.listPage({ namespace: 'worker', updatedAfter: 29, updatedBefore: 30, limit: 10 }).records.map(item => item.id), [record.id]);
  console.log('knowledge-store-hot-projection: startup rebuild, synchronized writes and column-backed paging passed');
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
