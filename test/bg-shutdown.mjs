import { installFakeOwnedBackground } from './helpers/background-pty.mjs';
/** Actual manager/shell paths; only process discovery and PTY boundaries are controlled.
 *  子代理（bgtasks.spawn）已于 2026-10-20 移除——改为带 parentSessionId 的普通会话，
 *  其来源继承回归见 test/session-tree.mjs 与 test/e2e 派活链路。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-shutdown-'));
const output = path.join(fixture, 'compiled');
const compile = createSharedCompiler(project, output);
const entry = compile('main/agentSession/background/manager.ts');
// Controllable OS shell discovery reproduces the launch await without timing guesses.
fs.writeFileSync(path.join(output, 'main/shell/profiles.mjs'), `
export async function listShellProfilesAsync() {
  await globalThis.bgProfileGate?.();
  return [{ id: 'cmd', label: 'test', command: 'cmd.exe', args: [] }];
}
`);
const { BackgroundTaskManager } = await import(pathToFileURL(entry));
const a = path.join(fixture, 'a'); const b = path.join(fixture, 'b'); const c = path.join(fixture, 'c');
const tree = path.join(fixture, 'external-tree');
for (const dir of [a, b, c, tree]) fs.mkdirSync(dir);
const workspace = { id: 'multi', path: a, controlRoot: a, defaultRootId: 'a', rootsRevision: 1,
  roots: [{ id: 'a', path: a }, { id: 'b', path: b }] };
const config = { workspaces: [workspace, { id: 'single', path: c }], activeWorkspaceId: 'single' };
const sessions = new Map([['parent', { id: 'parent', name: 'Parent', workspaceId: 'multi', runtime: 'pi', cwd: b,
  sourceRoot: { rootId: 'b', path: b, cwd: b }, modelOverride: { providerId: 'old', modelId: 'model' } }]]);
const spawns = []; const listeners = new Set(); const wakes = []; const sends = []; const connects = [];
let connectGate; let endStream; let closes = 0; let sendError;
const ctx = {
  config: { get: () => config }, getWindow: () => null, sessions: { get: id => sessions.get(id) },
  pty: {
    addExitListener: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    spawn: (id, launch, cwd) => { spawns.push({ id, launch, cwd }); },
    killAndWait: async () => {}, kill: () => {}, getBuffer: () => 'output'
  },
  agentSessions: {
    getPolicyState: () => ({ mode: 'default', planExecuting: false }),
    send: async (...args) => { wakes.push(args); },
    getDriver: () => ({ connect: async options => {
      connects.push(options); await connectGate?.();
      let finish; const finished = new Promise(resolve => { finish = resolve; }); endStream = finish;
      return { send: async text => { if (sendError) throw new Error(sendError); sends.push(text); }, close: async () => { closes++; finish(); },
        events: (async function* () { await finished; yield { type: 'turn-complete' }; })() };
    } })
  }
};
installFakeOwnedBackground(ctx.pty);
const manager = new BackgroundTaskManager(ctx, { userDataDir: fixture });
const { workspaceRootUsesFor } = await import(pathToFileURL(compile('main/workspaceRootUses.ts')));
const rootUses = workspaceRootUsesFor(ctx.config);
ctx.bgTasks = manager;
const parent = () => sessions.get('parent');
const task = id => manager.listFor('parent').find(row => row.id === id);
const until = async predicate => {
  const end = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < end, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
const holdProfiles = () => {
  let release; let entered = false;
  globalThis.bgProfileGate = () => { entered = true; return new Promise(resolve => { release = resolve; }); };
  return { entered: () => entered, release: () => { globalThis.bgProfileGate = undefined; release(); } };
};
const exit = id => { for (const listener of [...listeners]) listener(`bg-${id}`, 0); };
try {
  const gate = holdProfiles();
  manager.spawnShell('parent', b, 'echo delayed', undefined, false);
  manager.addTimer('parent', 50, 'must not wake');
  let stopped = false;
  const shutdown = manager.shutdown();
  assert.equal(manager.shutdown(), shutdown, 'concurrent shutdown shares barrier');
  shutdown.then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(stopped, false, 'shutdown waits for pending profile discovery');
  assert.equal(manager.addTimer('parent', 1, 'late').ok, false);
  assert.equal(manager.spawnShell('parent', b, 'late', undefined, false).ok, false);
  gate.release();
  await shutdown;
  assert.equal(spawns.length, 0, 'shutdown invalidates prepared launch before spawn');
  assert.equal(wakes.length, 0, 'cancelled timers never wake');
  assert.equal(listeners.size, 0);
  assert.equal(manager.snapTimers.size, 0);
  assert.equal(manager.persistTimer, null);
  const saved = JSON.parse(fs.readFileSync(path.join(fixture, 'bg-tasks.json'), 'utf8'));
  assert.ok(saved.tasks.every(task => task.status === 'cancelled'));
  const draining = new BackgroundTaskManager(ctx, { userDataDir: fixture });
  let releaseClose;
  ctx.pty.killAndWait = () => new Promise(resolve => { releaseClose = resolve; });
  draining.spawnShell('parent', b, 'echo close', undefined, false);
  await until(() => spawns.length === 1);
  await new Promise(resolve => setTimeout(resolve, 0));
  let drained = false;
  const drain = draining.shutdown(); drain.then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(drained, false, 'shutdown waits for real PTY close');
  releaseClose(); await drain;
  const failing = new BackgroundTaskManager(ctx, { userDataDir: fixture });
  const one = failing.addTimer('parent', 5000, 'first');
  const two = failing.addTimer('parent', 5000, 'second');
  let secondKilled = false;
  failing.runtimes.get(one.id).shell = { kill() { throw new Error('kill failed'); } };
  failing.runtimes.get(two.id).shell = { kill() { secondKilled = true; } };
  await assert.rejects(failing.shutdown(), /shutdown failed/);
  assert.equal(secondKilled, true, 'one failed kill does not skip remaining resources');
  assert.equal(failing.snapTimers.size, 0);
  failing.runtimes.get(one.id).shell.kill = () => {};
  await failing.shutdown();
  const retrying = new BackgroundTaskManager(ctx, { userDataDir: fixture });
  const completed = retrying.addTimer('parent', 5000, 'completed execution');
  clearTimeout(retrying.runtimes.get(completed.id).timer);
  Object.assign(retrying.tasks.get(completed.id), { status: 'done', exitCode: 0, summary: 'real output' });
  let attempts = 0;
  retrying.runtimes.set(completed.id, { shell: { kill() {}, close: async () => { if (++attempts === 1) throw Error('permission denied'); } } });
  await assert.rejects(retrying.killAndWait(completed.id), /permission denied/);
  assert.equal(retrying.listFor('parent').find(task => task.id === completed.id).status, 'done');
  assert.equal(retrying.listFor('parent').find(task => task.id === completed.id).exitCode, 0);
  assert.match(retrying.listFor('parent').find(task => task.id === completed.id).summary, /real output[\s\S]*进程清理失败/);
  assert.equal(retrying.remove(completed.id), false, 'failed close retains its owner and record');
  await retrying.killAndWait(completed.id);
  assert.equal(retrying.listFor('parent').find(task => task.id === completed.id).summary, 'real output');
  assert.equal(retrying.remove(completed.id), true);
  await retrying.shutdown();

  const cancelled = new BackgroundTaskManager(ctx, { userDataDir: fixture });
  const cancelledTask = cancelled.addTimer('parent', 5000, 'cancelled owner');
  let cancellationAttempts = 0;
  cancelled.runtimes.get(cancelledTask.id).shell = { kill() {}, close: async () => { if (++cancellationAttempts === 1) throw Error('retry close'); } };
  await assert.rejects(cancelled.killAndWait(cancelledTask.id), /retry close/);
  assert.equal(cancelled.listFor('parent').find(task => task.id === cancelledTask.id).status, 'cancelled');
  await cancelled.shutdown();
  assert.equal(cancellationAttempts, 2, 'shutdown retries residual cancelled resources');

  const preparing = new BackgroundTaskManager(ctx, { userDataDir: fixture });
  const pendingGate = holdProfiles(), previousSpawns = spawns.length;
  const pendingTask = preparing.spawnShell('parent', b, 'must not start', undefined, false);
  let cancellationSettled = false;
  const cancelling = preparing.killAndWait(pendingTask.id).then(() => { cancellationSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancellationSettled, false, 'kill confirmation includes pending launch');
  assert.equal(preparing.remove(pendingTask.id), false, 'pending owner cannot be discarded');
  pendingGate.release(); await cancelling;
  assert.equal(spawns.length, previousSpawns);
  await preparing.shutdown();
  const sessionClosing = new BackgroundTaskManager(ctx, { userDataDir: fixture });
  const sessionOne = sessionClosing.addTimer('parent', 5000, 'session first'), sessionTwo = sessionClosing.addTimer('parent', 5000, 'session second');
  let secondSessionOwnerClosed = false;
  sessionClosing.runtimes.get(sessionOne.id).shell = { kill() {}, close: async () => { throw Error('session owner failed'); } };
  sessionClosing.runtimes.get(sessionTwo.id).shell = { kill() {}, close: async () => { secondSessionOwnerClosed = true; } };
  await assert.rejects(sessionClosing.killAllForSessionAndWait('parent'), /session owner failed/);
  assert.equal(secondSessionOwnerClosed, true, 'one failed owner does not skip siblings on session close');
  sessionClosing.runtimes.get(sessionOne.id).shell.close = async () => {};
  await sessionClosing.killAllForSessionAndWait('parent'); await sessionClosing.shutdown();

  const { BackgroundPtyCleanupError } = await import(pathToFileURL(compile('main/pty/backgroundOwner.ts')));
  let releaseSucceeds = false;
  ctx.pty.spawnOwnedBackground = async (_id, _launch, _cwd, assertCurrent) => {
    assertCurrent();
    const completed = Promise.reject(new BackgroundPtyCleanupError(0, Error('natural release failed')));
    void completed.catch(() => {});
    return { completed, close: async () => { if (!releaseSucceeds) throw Error('natural release failed'); } };
  };
  const natural = new BackgroundTaskManager(ctx, { userDataDir: fixture });
  const naturalTask = natural.spawnShell('parent', b, 'successful command', undefined, false);
  await until(() => natural.cleanupErrors.has(naturalTask.id) && natural.runtimes.has(naturalTask.id));
  await new Promise(resolve => setTimeout(resolve, 0));
  const naturalRecord = natural.listFor('parent').find(task => task.id === naturalTask.id);
  assert.equal(naturalRecord.status, 'done', 'cleanup failure does not rewrite execution outcome');
  assert.equal(naturalRecord.exitCode, 0);
  assert.match(naturalRecord.summary, /output[\s\S]*进程清理失败/);
  releaseSucceeds = true;
  await natural.killAndWait(naturalTask.id);
  assert.equal(natural.listFor('parent').find(task => task.id === naturalTask.id).summary, 'output');
  await natural.shutdown();
  for (const outcome of ['resolve', 'reject']) {
    let settleWake, rejectWake, wakeStarted = false, pushed = 0;
    ctx.agentSessions.send = () => { wakeStarted = true; return new Promise((resolve, reject) => { settleWake = resolve; rejectWake = reject; }); };
    ctx.getWindow = () => ({ webContents: { send() { pushed++; } } });
    const waking = new BackgroundTaskManager(ctx, { userDataDir: fixture });
    const wakingTask = waking.addTimer('parent', 0, 'pending GUI connection');
    await until(() => wakeStarted);
    await waking.killAndWait(wakingTask.id);
    let deadline;
    try {
      await Promise.race([waking.shutdown(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('background drain waited on GUI-owned send')), 1000); })]);
    } finally { clearTimeout(deadline); }
    const frozen = JSON.stringify(waking.listFor('parent'));
    const persisted = fs.readFileSync(path.join(fixture, 'bg-tasks.json'), 'utf8');
    const beforePush = pushed;
    assert.equal(waking.listFor('parent').find(task => task.id === wakingTask.id).pendingDigest, true);
    if (outcome === 'resolve') settleWake({ ok: false }); else rejectWake(Error('late GUI rejection'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(JSON.stringify(waking.listFor('parent')), frozen, 'late GUI receipt cannot mutate disposed background state');
    assert.equal(fs.readFileSync(path.join(fixture, 'bg-tasks.json'), 'utf8'), persisted);
    assert.equal(pushed, beforePush);
  }
  ctx.getWindow = () => null;
  console.log('bg-shutdown: ok');
} finally {
  delete globalThis.bgProfileGate;
  fs.rmSync(fixture, { recursive: true, force: true });
}
