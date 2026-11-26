import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = fs.realpathSync(process.cwd());
const parent = path.join(root, '.tmp'); fs.mkdirSync(parent, { recursive: true });
const resolvedParent = fs.realpathSync(parent), parentRelative = path.relative(root, resolvedParent);
if (!parentRelative || parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
  throw new Error('SQLite fixture parent is outside the task worktree');
}
const base = fs.mkdtempSync(path.join(resolvedParent, 'sqlite-long-regression-'));
let log, waits, reminders, memory, history, auditStore;
try {
  const compile = createSharedCompiler(root, path.join(base, 'compiled'));
  const { sqliteFilePath } = await import(pathToFileURL(compile('main/sqliteFilePath.ts')));
  const eventUrl = pathToFileURL(compile('main/awareness/eventLog.ts'));
  const waitUrl = pathToFileURL(compile('main/resumeWait/store.ts'));
  const { EventLog } = await import(eventUrl);
  const { ResumeWaitStore } = await import(waitUrl);
  const { SessionReminderStore } = await import(pathToFileURL(compile('main/sessionReminders/store.ts')));
  const { SqliteDesktopEpochHistory } = await import(pathToFileURL(compile('main/desktop/epochHistory.ts')));
  const { DesktopAuditStore } = await import(pathToFileURL(compile('main/desktop/auditStore.ts')));
  const windowsPath = 'C:\\example\\database.sqlite';
  assert.equal(sqliteFilePath(windowsPath, 'win32'), '\\\\?\\C:\\example\\database.sqlite');
  assert.equal(sqliteFilePath('\\\\server\\share\\db.sqlite', 'win32'), '\\\\?\\UNC\\server\\share\\db.sqlite');
  assert.equal(sqliteFilePath(':memory:', 'win32'), ':memory:');
  assert.equal(sqliteFilePath('file::memory:?cache=shared', 'win32'), 'file::memory:?cache=shared');
  assert.equal(sqliteFilePath('/tmp/db.sqlite', 'linux'), '/tmp/db.sqlite');
  assert.equal(sqliteFilePath('/tmp/db.sqlite', 'darwin'), '/tmp/db.sqlite');

  const directory = path.join(base, ...Array(4).fill('long-' + 'x'.repeat(42)));
  fs.mkdirSync(directory, { recursive: true });
  if (process.platform === 'win32') assert.ok(path.join(directory, 'event-log.sqlite').length > 260);
  log = new EventLog(directory);
  const event = log.append({ source: 'fact', type: 'test', scope: 'scope', workspaceId: 'w', receivedAt: 1, summary: 'event', payload: '{}' });
  waits = new ResumeWaitStore(directory);
  const wait = waits.arm({ owner: 'worker', workspaceId: 'w', condition: { kind: 'mail' }, note: 'continue', priority: 'normal', deadlineAt: null }, 2);
  assert.equal(wait.eventCursor, event.event.sequence, 'both services open the same event database');
  reminders = new SessionReminderStore(path.join(directory, 'reminders.sqlite'));
  history = new SqliteDesktopEpochHistory(path.join(directory, 'epochs.sqlite'));
  const epochGeneration = history.generation('session');
  history.record('session', epochGeneration, 'task');
  history.close(); history = new SqliteDesktopEpochHistory(path.join(directory, 'epochs.sqlite'));
  assert.equal(history.owns('session', epochGeneration, 'task'), true);
  assert.equal(history.findByHash('session', epochGeneration, createHash('sha256').update('task').digest('hex')), 'task');
  history.endSession('session');
  assert.equal(history.owns('session', epochGeneration, 'task'), false);
  auditStore = new DesktopAuditStore(path.join(directory, 'audit.sqlite'));
  auditStore.append({ sessionId: 'session', taskId: 'task', source: 'desktop', action: 'look', stage: 'read', result: 'allowed' });
  auditStore.close(); auditStore = new DesktopAuditStore(path.join(directory, 'audit.sqlite'));
  assert.equal(auditStore.list('session').length, 1);
  reminders.add('session', 'remember test', null);
  memory = new SessionReminderStore(':memory:');
  memory.add('session', 'memory test', null);
  assert.equal(memory.list('session').length, 1);
  memory.close(); memory = undefined;
  reminders.close(); reminders = undefined;
  waits.close(); waits = undefined;
  log.close(); log = undefined;
  log = new EventLog(directory); waits = new ResumeWaitStore(directory);
  reminders = new SessionReminderStore(path.join(directory, 'reminders.sqlite'));
  assert.equal(log.list({ source: 'fact' }).length, 1);
  assert.equal(waits.get(wait.id)?.note, 'continue');
  assert.equal(reminders.list('session')[0].text, 'remember test');
  const electron = createRequire(import.meta.url)('electron');
  const childScript = path.join(base, 'electron-sqlite.cjs');
  fs.writeFileSync(childScript, `
    (async () => {
      const { EventLog } = await import(${JSON.stringify(eventUrl.href)});
      const { ResumeWaitStore } = await import(${JSON.stringify(waitUrl.href)});
      const directory = ${JSON.stringify(path.join(directory, 'electron'))};
      const log = new EventLog(directory);
      const event = log.append({ source: 'fixture', type: 'sample', scope: 'scope', receivedAt: 1, summary: 'ok', payload: '{}' });
      const waits = new ResumeWaitStore(directory);
      const wait = waits.arm({ owner: 'worker', workspaceId: 'w', condition: { kind: 'mail' }, note: 'continue', priority: 'normal', deadlineAt: null }, 2);
      if (wait.eventCursor !== event.event.sequence) throw new Error('Electron stores did not share the same database');
      waits.close(); log.close();
      console.log('electron-sqlite-long-path: ok');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  const output = execFileSync(electron, [childScript], { cwd: base,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 30000 });
  assert.match(output, /electron-sqlite-long-path: ok/);
  console.log('sqlite long path: native filesystem, shared WAL, reopen and in-memory database passed');
} finally {
  auditStore?.close(); history?.close(); memory?.close(); reminders?.close(); waits?.close(); log?.close();
  const resolvedBase = fs.realpathSync(base);
  const relative = path.relative(resolvedParent, resolvedBase);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      !path.basename(resolvedBase).startsWith('sqlite-long-regression-')) throw new Error('Invalid SQLite fixture cleanup target');
  fs.rmSync(resolvedBase, { recursive: true, force: true, maxRetries: 5 });
}
