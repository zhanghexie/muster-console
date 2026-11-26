import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-worker-epoch-'));
let history;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const { SqliteDesktopEpochHistory } = await import(pathToFileURL(compile('main/desktop/epochHistory.ts')));
  const { WorkerDesktopEpochs } = await import(pathToFileURL(compile('main/desktop/workerEpoch.ts')));
  history = new SqliteDesktopEpochHistory(path.join(tmp, 'history.sqlite'));
  const row = { id: 'worker', workspaceId: 'workspace', type: 'terminal', launchKind: 'agent', archived: false };
  let token = {}, available = true;
  const sessions = { peek: id => available && id === row.id ? row : undefined,
    sessionScopeToken: id => available && id === row.id && !row.archived ? token : undefined };
  const epochs = new WorkerDesktopEpochs(sessions, history);
  const old = epochs.capture('worker', 'workspace');
  assert.equal(old.taskId, 'worker');
  assert.deepEqual(epochs.currentBinding('worker'), { epoch: 'worker', anchor: 'worker', generation: 0 });
  assert.equal(old.isCurrent(), true);
  assert.throws(() => epochs.capture('worker', 'other-workspace'), /workspace/i);
  epochs.invalidateBeforeArchive('worker');
  row.archived = true; token = {};
  assert.equal(old.isCurrent(), false);
  assert.equal(epochs.currentBinding('worker'), null);
  row.archived = false;
  const renewed = epochs.capture('worker', 'workspace');
  assert.equal(renewed.taskId, 'worker');
  assert.equal(renewed.generation, 1);
  assert.equal(old.isCurrent(), false, 'unarchive cannot revive the original approval');
  assert.equal(renewed.isCurrent(), true);
  available = false;
  assert.equal(renewed.isCurrent(), false);
  available = true;
  const failingHistory = { generation: id => history.generation(id), record: (...args) => history.record(...args),
    owns: (...args) => history.owns(...args), findByHash: (...args) => history.findByHash(...args),
    endSession: () => { throw Error('generation storage failed'); }, endSessions: () => { throw Error('generation storage failed'); } };
  const failing = new WorkerDesktopEpochs(sessions, failingHistory);
  const beforeFailure = failing.capture('worker', 'workspace');
  assert.throws(() => failing.invalidateBeforeArchive('worker'), /storage failed/);
  assert.equal(beforeFailure.isCurrent(), false, 'storage failure invalidates this process immediately');
  assert.throws(() => failing.currentBinding('worker'), /重启|restart/i, 'failed invalidation is unknown rather than no epoch');
  console.log('worker desktop epoch: trusted session lease, workspace and archive generation');
} finally {
  history?.close();
  const resolved = fs.realpathSync(tmp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('desktop-worker-epoch-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
