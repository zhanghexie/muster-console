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
import { codexWorktreeFixture, fixtureGit } from './helpers/codex-worktree.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-source-'));
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
  let gate = holdProfiles();
  const first = manager.spawnShell('parent', b, 'echo source', undefined, false);
  assert.equal(first.ok, true); assert.equal(task(first.id).sourceRoot.rootId, 'b');
  // A consumer cannot mutate the manager's stored source through a list result.
  task(first.id).sourceRoot.rootId = 'a'; assert.equal(task(first.id).sourceRoot.rootId, 'b');
  workspace.defaultRootId = 'b'; workspace.path = b; workspace.rootsRevision++;
  config.activeWorkspaceId = 'multi'; gate.release();
  await until(() => spawns.length === 1); assert.equal(spawns[0].cwd, b); exit(first.id); await Promise.resolve();
  assert.equal(task(first.id).status, 'done');
  console.log('ok: dispatch metadata/cwd stay pinned across defaults and active workspace changes');

  gate = holdProfiles(); const removed = manager.spawnShell('parent', b, 'echo removed', undefined, true);
  workspace.roots = [{ id: 'a', path: a }]; gate.release();
  await until(() => task(removed.id).status === 'error');
  assert.equal(spawns.length, 1); assert.equal(wakes.length, 0);
  assert.match(task(removed.id).summary, /source folder not found/);
  workspace.roots.push({ id: 'b', path: b });
  console.log('ok: removal during shell discovery rejects spawn and does not wake a relocated parent');

  gate = holdProfiles(); const cancelled = manager.spawnShell('parent', b, 'echo cancelled', undefined, false);
  manager.kill(cancelled.id, 'user'); gate.release();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(spawns.length, 1); assert.equal(task(cancelled.id).status, 'cancelled');
  assert.equal(manager.spawnShell('missing', b, 'echo', undefined, false).ok, false);
  assert.equal(manager.spawnShell('parent', a, 'echo', undefined, false).ok, false);
  console.log('ok: cancellation, missing parent and stale execution cwd do not create processes');

  const link = path.join(fixture, 'source-link'); fs.symlinkSync(b, link, 'junction');
  workspace.roots.push({ id: 'link', path: link });
  const savedParent = structuredClone(parent()); parent().cwd = link;
  parent().sourceRoot = { rootId: 'link', path: link, cwd: link };
  gate = holdProfiles(); const linked = manager.spawnShell('parent', link, 'echo linked', undefined, false);
  fs.unlinkSync(link); fs.symlinkSync(c, link, 'junction'); gate.release();
  await until(() => task(linked.id).status === 'error'); assert.equal(spawns.length, 1);
  sessions.set('parent', savedParent); workspace.roots = workspace.roots.filter(root => root.id !== 'link');
  console.log('ok: retargeting a registered Junction during discovery refuses launch');

  parent().worktreePath = tree; parent().worktreeSource = { mainRepo: b }; parent().cwd = tree;
  const isolated = manager.spawnShell('parent', tree, 'echo isolated', undefined, false);
  await until(() => spawns.length === 2); assert.equal(spawns.at(-1).cwd, tree);
  assert.equal(task(isolated.id).sourceRoot.rootId, 'b'); exit(isolated.id); await Promise.resolve();
  parent().cwd = b; delete parent().worktreePath; delete parent().worktreeSource;
  console.log('ok: an external worktree inherits the parent source and its actual isolated cwd');


  gate = holdProfiles(); const timed = manager.runShellWithTimeout('parent', b, 'echo timed', undefined, false, undefined, 500);
  workspace.roots = [{ id: 'a', path: a }]; gate.release();
  const result = await timed; assert.equal(result.ok, false); assert.equal(spawns.length, 2);
  workspace.roots.push({ id: 'b', path: b });
  const timer = manager.addTimer('parent', 20, 'check');
  parent().cwd = a; parent().sourceRoot = { rootId: 'a', path: a, cwd: a };
  const wakeCount = wakes.length; await until(() => task(timer.id).status === 'error');
  assert.equal(wakes.length, wakeCount); assert.equal(task(timer.id).pendingDigest, true);
  console.log('ok: timeout launches and timer wakeups cannot redirect to a changed parent source');

  const codexTree = path.join(fixture, 'codex task tree');
  const codexPlacement = codexWorktreeFixture(b, codexTree, 'b');
  Object.assign(parent(), codexPlacement, { runtime: 'codex-gui' });
  assert.equal(manager.spawnShell('parent', b, 'echo source', undefined, false).ok, false);
  const codexTask = manager.spawnShell('parent', codexTree, 'echo isolated codex', undefined, false);
  assert.equal(codexTask.ok, true);
  await until(() => spawns.length === 3);
  assert.equal(spawns.at(-1).cwd, codexTree);
  assert.equal(task(codexTask.id).cwd, codexTree);
  exit(codexTask.id);
  gate = holdProfiles();
  const staleCodex = manager.spawnShell('parent', codexTree, 'echo stale codex', undefined, false);
  await until(gate.entered);
  fixtureGit(codexTree, 'switch', '-qc', 'wrong-branch');
  gate.release();
  await until(() => task(staleCodex.id).status === 'error');
  assert.match(task(staleCodex.id).summary, /branch changed/);
  assert.equal(spawns.length, 3);

  manager.shutdown();
  const restored = new BackgroundTaskManager(ctx, { userDataDir: fixture });
  assert.equal(restored.listFor('parent').find(row => row.id === first.id).sourceRoot.rootId, 'b');
  assert.equal(restored.listFor('parent').find(row => row.id === isolated.id).cwd, tree);
  restored.shutdown();
  console.log('ok: persisted records retain the dispatch source, including isolated cwd');
} finally {
  globalThis.bgProfileGate = undefined; connectGate = undefined; endStream?.(); manager.shutdown();
}
console.log('bg-task-source: OK');
