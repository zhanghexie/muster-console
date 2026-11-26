/** The settings cleanup reuses the safe archive path and protects session lifecycle. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-worktree-'));
const originalLoad = Module._load;
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => fixture, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
try {
  const { SessionsService } = require(path.join(root, 'src/main/sessions.ts'));
  const { beginTaskWorktreeOperation } = require(path.join(root, 'src/main/git/worktreeTaskOperation.ts'));
  const owner = { id: 'owner', type: 'terminal', name: 'task', createdAt: 1, archived: true, status: 'exited', worktreePath: path.join(fixture, 'tree') };
  const service = Object.create(SessionsService.prototype), config = { get: () => ({}) };
  let cleanupCalls = 0;
  Object.assign(service, { sessions: [owner], config, get: id => service.sessions.find(row => row.id === id), persist() {}, broadcast() {},
    archiveReleaseThenCleanup: async row => { cleanupCalls++; delete row.worktreePath; } });
  const borrower = { id: 'borrower', type: 'terminal', name: 'child', createdAt: 2, archived: false, cwd: path.join(owner.worktreePath, 'nested') };
  service.sessions.push(borrower);
  assert.equal((await service.cleanupArchivedWorktree('owner')).ok, false);
  assert.equal(cleanupCalls, 0, 'a live reference prevents cleanup');
  service.sessions.pop();
  assert.equal((await service.cleanupArchivedWorktree('owner')).ok, true);
  assert.equal(cleanupCalls, 1, 'the normal archive cleanup is used');
  owner.worktreePath = path.join(fixture, 'tree');
  service.archiveReleaseThenCleanup = async () => { cleanupCalls++; };
  assert.equal((await service.cleanupArchivedWorktree('owner')).ok, false, 'a retained worktree is not reported as removed');
  service.archiveReleaseThenCleanup = async () => ({ ok: false, message: 'task branch has unmerged commits' });
  assert.equal((await service.cleanupArchivedWorktree('owner')).message, 'task branch has unmerged commits', 'the safety-check reason reaches the storage result');
  const lease = beginTaskWorktreeOperation(config, 'owner', 'cleanup');
  try {
    assert.throws(() => service.setArchived('owner', false), /already running/);
    await assert.rejects(service.respawn('owner'), /already running/);
    await assert.rejects(service.discardWorktree('owner'), /already running/);
    await assert.rejects(service.integrateWorktree('owner', undefined, 'human'), /already running/);
  } finally { lease.release(); }
  console.log('session-storage-worktree: archive cleanup and lifecycle guards passed');
} finally {
  Module._load = originalLoad;
  fs.rmSync(fixture, { recursive: true, force: true });
}
