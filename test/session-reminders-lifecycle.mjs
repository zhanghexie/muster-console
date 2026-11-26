/** Actual session deletion removes only its reminders, including scheduler failures/retries. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reminders-lifecycle-'));
const schedulerDir = path.join(temp, 'scheduler'), schedulerTaskDir = path.join(temp, 'scheduler-tasks');
fs.mkdirSync(schedulerDir); fs.mkdirSync(schedulerTaskDir);
const providerSource = ts.createSourceFile('piProvider.ts', fs.readFileSync(path.join(root, 'src/main/agent/providers/piProvider.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const deleteDeclaration = providerSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'deletePiSession');
assert.ok(deleteDeclaration, 'the real scheduler file deletion entry must exist');
const emittedDelete = ts.transpileModule(`${deleteDeclaration.getText(providerSource).replace(/^export\s+/, '')}\nexports.deletePiSession = deletePiSession;`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const provider = {};
new Function('exports', 'dirname', 'existsSync', 'fsp', 't', emittedDelete)(provider, path.dirname, fs.existsSync, fs.promises, text => text);
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText, filename);
};
let deleteFileResult;
const originalLoad = Module._load;
Module._load = function(request, parent) {
  if (request === 'electron') return { app: { getPath: () => temp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  if (request === '../providers/piProvider' && parent?.filename.endsWith(`${path.sep}orchestrator${path.sep}sessions.ts`)) {
    return { deletePiSession: async (...args) => deleteFileResult ?? provider.deletePiSession(...args) };
  }
  return originalLoad.apply(this, arguments);
};

const { SessionsService } = require(path.join(root, 'src/main/sessions.ts'));
const { deleteSession: deleteSchedulerSession } = require(path.join(root, 'src/main/agent/orchestrator/sessions.ts'));
const reminders = require(path.join(root, 'src/main/sessionReminders/service.ts'));
const { SessionReminderStore } = require(path.join(root, 'src/main/sessionReminders/store.ts'));
const taskCleanup = require(path.join(root, 'src/main/git/worktreeTaskCleanup.ts'));
const config = { get: () => ({ activeWorkspaceId: 'ws', workspaces: [{ id: 'ws', path: temp }] }) };
const ids = { parent: '00000000-0000-4000-8000-000000000001', child: '00000000-0000-4000-8000-000000000002',
  other: '00000000-0000-4000-8000-000000000003', failure: '00000000-0000-4000-8000-000000000004',
  asyncFailure: '00000000-0000-4000-8000-000000000005', previous: '00000000-0000-4000-8000-000000000006' };
const makeRow = (id, parentSessionId) => ({ id, name: id, type: 'terminal', launchKind: 'agent', runtime: 'opencode',
  archived: true, cwd: temp, workspaceId: 'ws', ...(parentSessionId ? { parentSessionId } : {}) });
const service = Object.create(SessionsService.prototype);
const notices = [];
Object.assign(service, { config, sessions: [], activeId: null, notify: { push: value => notices.push(value) },
  rememberEnded() {}, notifySessionRemoved() {}, persist() {}, broadcast() {}, isChatRuntime: () => false,
  resolveWorkspaceId: () => 'ws', launchTasks: new Map(), launchGen: new Map(), classifyBySession: new Map(),
  ptyWorkingSince: new Map(), notifyBus: { clearSession() {} }, ptyMgr: { kill() {}, async killAndWait() {} }, awareness: null });
service.get = id => service.sessions.find(row => row.id === id);
let schedulerFile = path.join(schedulerDir, 'scheduler-a.jsonl');
const ctx = { sessions: service, workspaces: { list: () => [{ id: 'ws' }] },
  store: { getPiSessionDir: id => id.endsWith(':tasks') ? schedulerTaskDir : schedulerDir },
  orchestrator: { getHistory() {throw new Error('reminders must not load transcript bodies');}, getCurrentSessionFile: () => schedulerFile }, getWindow: () => null };
const dbFile = path.join(temp, 'session-reminders.sqlite');
function add(target, text) {
  const scope = reminders.resolveReminderScope(ctx, target);
  reminders.addSessionReminder(ctx, target, text, null);
  return scope;
}
function count(scope) {
  const store = new SessionReminderStore(dbFile);
  try { return store.list(scope).length; } finally { store.close(); }
}

try {
  service.sessions = [makeRow(ids.parent), makeRow(ids.child, ids.parent), makeRow(ids.other)];
  const parent = add({ kind: 'session', sessionId: ids.parent }, '父会话');
  const child = add({ kind: 'session', sessionId: ids.child }, '子会话');
  const other = add({ kind: 'session', sessionId: ids.other }, '其他会话');
  service.close(ids.parent);
  assert.equal(count(parent), 0, 'deleting a parent purges its reminders');
  assert.equal(count(child), 0, 'cascaded child deletion purges its reminders');
  assert.equal(count(other), 1, 'unrelated sessions are untouched');

  service.sessions.push(makeRow(ids.failure));
  const failed = add({ kind: 'session', sessionId: ids.failure }, '清理失败时保留');
  const originalDeleteScope = SessionReminderStore.prototype.deleteScope;
  SessionReminderStore.prototype.deleteScope = () => { throw new Error('simulated database failure'); };
  try {
    assert.throws(() => service.close(ids.failure), /待办清理失败.*simulated database failure/);
    assert.ok(service.get(ids.failure), 'a failed purge does not remove the session');
    assert.equal(count(failed), 1, 'a failed purge retains the reminder');
  } finally { SessionReminderStore.prototype.deleteScope = originalDeleteScope; }
  service.close(ids.failure);
  assert.equal(count(failed), 0, 'retry purges the reminder');

  const asyncRow = makeRow(ids.asyncFailure);
  asyncRow.worktreeGroups = { version: 1, primaryGroupId: 'a', cwdPolicy: 'source', groups: [{ id: 'a', path: temp, repos: [] }] };
  service.sessions.push(asyncRow);
  const asyncScope = add({ kind: 'session', sessionId: asyncRow.id }, '异步清理失败');
  const originalTaskCleanup = taskCleanup.cleanupTaskWorktrees;
  taskCleanup.cleanupTaskWorktrees = async (_ctx, row) => { delete row.worktreeGroups; return { ok: true }; };
  SessionReminderStore.prototype.deleteScope = () => { throw new Error('simulated asynchronous failure'); };
  try {
    service.close(asyncRow.id);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(service.get(asyncRow.id), 'failed purge retains the asynchronously cleaned session');
    assert.equal(count(asyncScope), 1);
    assert.ok(notices.some(item => /会话删除失败.*simulated asynchronous failure/.test(item.text)));
  } finally {
    taskCleanup.cleanupTaskWorktrees = originalTaskCleanup;
    SessionReminderStore.prototype.deleteScope = originalDeleteScope;
  }
  service.close(asyncRow.id);
  assert.equal(count(asyncScope), 0, 'the asynchronous deletion can be retried');

  service.sessions.push(makeRow(ids.previous));
  const previous = add({ kind: 'session', sessionId: ids.previous }, '旧版留下的提醒');
  service.sessions = service.sessions.filter(row => row.id !== ids.previous);
  service.store = { loadEndedSessionRefs: () => [{ id: ids.previous }, { id: ids.other }] };
  const originalDeleteScopes = SessionReminderStore.prototype.deleteScopes;
  SessionReminderStore.prototype.deleteScopes = () => { throw new Error('simulated startup failure'); };
  try {
    service.hydrateEndedRefs([]);
    assert.equal(count(previous), 1, 'failed startup cleanup retains the record for retry');
    assert.match(notices.at(-1).text, /已删除会话的待办清理失败.*simulated startup failure/);
  } finally { SessionReminderStore.prototype.deleteScopes = originalDeleteScopes; }
  service.hydrateEndedRefs([]);
  assert.equal(count(previous), 0, 'known deleted sessions are reconciled on startup');
  assert.equal(count(other), 1, 'even a stale tombstone cannot remove a live session');

  const schedulerTarget = { kind: 'scheduler', workspaceId: 'ws' };
  fs.writeFileSync(schedulerFile, 'scheduler A');
  const scopeA = add(schedulerTarget, '调度 A');
  schedulerFile = path.join(schedulerDir, 'scheduler-b.jsonl');
  fs.writeFileSync(schedulerFile, 'scheduler B');
  const scopeB = add(schedulerTarget, '调度 B');
  schedulerFile = path.join(schedulerDir, 'scheduler-a.jsonl');
  const bucket = { piSessionFile: schedulerFile, display: [], api: [], queue: [] };
  const orchestrator = { ctx, buckets: new Map([['ws', bucket]]), ensureBucket: () => bucket, invalidatePiSession() {}, persistBucket() {}, emit() {}, emitContextStatus() {} };
  deleteFileResult = { ok: false, error: 'unlink denied' };
  assert.deepEqual(await deleteSchedulerSession(orchestrator, 'ws', schedulerFile), deleteFileResult);
  assert.equal(count(scopeA), 1, 'failed session file deletion must retain reminders');
  assert.equal(bucket.piSessionFile, schedulerFile);
  deleteFileResult = undefined;
  assert.deepEqual(await deleteSchedulerSession(orchestrator, 'ws', schedulerFile), { ok: true });
  assert.equal(fs.existsSync(schedulerFile), false, 'the real scheduler file is removed');
  assert.equal(count(scopeA), 0, 'scheduler history deletion purges its reminders');
  assert.equal(count(scopeB), 1, 'other scheduler history remains intact');
  assert.equal(bucket.piSessionFile, undefined);

  schedulerFile = path.join(schedulerDir, 'scheduler-c.jsonl');
  fs.writeFileSync(schedulerFile, 'scheduler C');
  const scopeC = add(schedulerTarget, '清理失败需重试');
  bucket.piSessionFile = schedulerFile;
  SessionReminderStore.prototype.deleteScope = () => { throw new Error('simulated database failure'); };
  try {
    const result = await deleteSchedulerSession(orchestrator, 'ws', schedulerFile);
    assert.equal(result.ok, false);
    assert.match(result.error, /会话已删除，但.*清理失败.*simulated database failure/);
    assert.equal(bucket.piSessionFile, undefined, 'deleted session is not left as the active conversation');
    assert.equal(count(scopeC), 1);
  } finally { SessionReminderStore.prototype.deleteScope = originalDeleteScope; }
  assert.deepEqual(await deleteSchedulerSession(orchestrator, 'ws', schedulerFile), { ok: true });
  assert.equal(count(scopeC), 0, 'repeating deletion retries a failed cleanup');
  console.log('session-reminders-lifecycle: session, subtree, scheduler, isolation and failure/retry passed');
} finally {
  await new Promise(resolve => setImmediate(resolve));
  reminders.closeSessionReminderStore();
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), os.tmpdir());
  assert.ok(path.basename(resolved).startsWith('session-reminders-lifecycle-'));
  fs.rmSync(resolved, { recursive: true, force: true });
  Module._load = originalLoad;
}
