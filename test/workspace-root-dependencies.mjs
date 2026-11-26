/** Real removal service/IPC/file mutation/creation state machines with real directories. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'root-dependencies-'));
const electronDir = path.join(fixture, 'node_modules/electron'); fs.mkdirSync(electronDir, { recursive: true });
fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' }));
fs.writeFileSync(path.join(electronDir, 'index.mjs'), `
export const handlers = new Map();
export const app = { getPath: () => ${JSON.stringify(fixture)}, isReady: () => true };
export const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), on() {} };
export const dialog = {}; export const shell = {}; export const clipboard = {}; export const webContents = {};
export const protocol = {}; export const session = { defaultSession: {} }; export const nativeImage = {};
export class BrowserWindow {} export class WebContentsView {} export class Notification {}
`);
const bundle = path.join(fixture, 'root-dependencies.mjs');
await require('esbuild').build({
  stdin: { contents: `
export { WorkspaceService } from './src/main/workspaces';
export { SessionsService } from './src/main/sessions';
export { PromptTasksManager } from './src/main/tasks/manager';
export { workspaceRootUsesFor, holdPendingSource } from './src/main/workspaceRootUses';
export { bindWorkspaceRootDependencies, workspaceRootDependencies } from './src/main/workspaceRootDependencies';
export { withWorkspaceFileMutation } from './src/main/workspaceFileAccess';
export { registerFsIpc } from './src/main/ipc/fs';
export { invokeIpcChannel } from './src/main/ipc/handle';
export * as queue from './src/main/tasks/delegateQueue';
`, resolveDir: project, loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
  plugins: [{ name: 'project-packages', setup(build) {
    build.onResolve({ filter: /^[^./]/ }, args => {
      if (args.path === 'electron' || args.path.startsWith('node:') || builtinModules.includes(args.path)) return;
      return { path: import.meta.resolve(args.path), external: true };
    });
  } }]
});
const { WorkspaceService, SessionsService, PromptTasksManager, workspaceRootUsesFor, holdPendingSource,
  bindWorkspaceRootDependencies, workspaceRootDependencies, withWorkspaceFileMutation, registerFsIpc,
  invokeIpcChannel, queue } = await import(pathToFileURL(bundle));
const { handlers: desktopHandlers } = await import(pathToFileURL(path.join(electronDir, 'index.mjs')));
// Filesystem completion needs elapsed time under the concurrent commit gate;
// a fixed number of setImmediate turns can finish before I/O has progressed.
async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'asynchronous state did not become ready');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const a = path.join(fixture, 'a'), b = path.join(fixture, 'b'), tree = path.join(fixture, 'tree');
for (const folder of [a, b, tree]) fs.mkdirSync(folder);
fs.writeFileSync(path.join(b, 'same.txt'), 'b');
let cfg = { defaultRuntime: 'pi', activeWorkspaceId: 'ws', workspace: a, workspaces: [{
  id: 'ws', name: 'Multi', path: a, controlRoot: a, rootsRevision: 1, defaultRootId: 'a',
  roots: [{ id: 'a', path: a }, { id: 'b', path: b }]
}] };
let writes = 0;
const config = { get: () => cfg, onChanged: () => () => {}, update: patch => { writes++; cfg = { ...cfg, ...patch }; return cfg; } };
const source = rootId => ({ rootId, path: rootId === 'a' ? a : b, cwd: rootId === 'a' ? a : b });
const rows = []; const background = [];
const sessions = {
  config, sessions: rows, rootDependencyRoster: () => structuredClone(rows), list: () => rows, listByWorkspace: () => [],
  get: id => rows.find(row => row.id === id),
  touchScheduledSession() {}, removeScheduledSession() {}, createScheduledTaskSession() {}, updateScheduledTaskSession() {},
  isChatRuntime: () => true,
};
const runtimes = { get: id => ({ id, enabled: true, surface: 'chat' }) };
const manager = new PromptTasksManager({ loadPromptTasks: () => [], loadTaskRuns: () => [], savePromptTasks() {}, saveTaskRuns() {} }, config, sessions, runtimes);
const workspaces = new WorkspaceService(config);
const ctx = { config, sessions, tasks: manager, workspaces, bgTasks: { runningSourceRoster: () => background.filter(task => task.status === 'running') } };
bindWorkspaceRootDependencies(ctx);
const remove = () => workspaces.updateMeta('ws', { roots: [{ id: 'a', path: a }], defaultRootId: 'a', expectedRootsRevision: 1 });
const blocked = kind => {
  const before = writes; const result = remove();
  assert.equal(result.ok, false, `root in use by ${kind} cannot be removed`);
  assert.ok(result.rootDependencies.some(use => use.kind === kind && use.rootId === 'b'));
  assert.equal(writes, before); assert.equal(fs.existsSync(b), true);
  return result;
};
try {
  rows.push({ id: 'running', type: 'terminal', name: 'B worker', workspaceId: 'ws', sourceRoot: source('b'), cwd: b, status: 'running' });
  blocked('session'); rows[0].status = 'exited';
  rows[0].worktreePath = tree; rows[0].archived = true; blocked('worktree');
  rows.length = 0;
  const grouped = { id: 'groups', type: 'terminal', name: 'Two-source isolated task', workspaceId: 'ws',
    sourceRoot: source('a'), cwd: tree, status: 'exited', archived: true, hidden: true,
    worktreeGroups: { version: 1, primaryGroupId: 'a', groups: [
      { id: 'a', path: tree, sourceRoot: source('a'), source: { mainRepo: a, commonDir: path.join(a, '.git') }, branch: 'ao/task', repos: [] },
      { id: 'b', path: path.join(fixture, 'second-tree'), sourceRoot: source('b'), source: { mainRepo: b, commonDir: path.join(b, '.git') }, branch: 'ao/task', repos: [] }
    ] } };
  rows.push(grouped);
  assert.equal(blocked('worktree').rootDependencies.find(use => use.rootId === 'b').label, path.join(fixture, 'second-tree'));
  grouped.worktreeGroups.groups[1].source.commonDir = grouped.worktreeGroups.groups[0].source.commonDir;
  blocked('worktree'); // Invalid group accounting must retain every potential source.
  rows.length = 0;
  rows.push({ id: 'legacy', type: 'terminal', name: 'Legacy worker', workspaceId: 'ws', cwd: b, status: 'running' });
  blocked('session'); rows.length = 0;
  background.push({ id: 'background', label: 'B shell', workspaceId: 'ws', sourceRoot: source('b'), status: 'running' });
  blocked('background-task'); background[0].status = 'done';
  const task = manager.create({ name: 'Disabled B service', prompt: 'p', runtime: 'pi', workspaceId: 'ws', rootId: 'b', enabled: false,
    schedule: { kind: 'interval', intervalMinutes: 60 } });
  blocked('service'); manager.delete(task.id);
  console.log('ok: running/legacy sessions, archived retained trees, background jobs and disabled services prevent removal');

  const queued = queue.enqueueDelegate(ctx, 'ws', { isolate: false, task: 'queued', rootId: 'b', name: 'B queued' });
  blocked('queued-task');
  let finish;
  queue.bindDelegateRunner(() => new Promise(resolve => { finish = resolve; }));
  const draining = queue.drainDelegateQueue('ws');
  assert.equal(queue.listDelegateQueue('ws').length, 0);
  blocked('queued-task');
  const projected = queue.listDelegateSourceUses('ws'); projected[0].sourceRoot.rootId = 'a';
  assert.equal(queue.listDelegateSourceUses('ws')[0].sourceRoot.rootId, 'b');
  finish({ ok: true }); await draining;
  assert.equal(queue.listDelegateSourceUses('ws').length, 0);
  console.log('ok: shifted queue item remains a dependency until the actual runner settles');

  let serviceReady;
  sessions.createTerminal = () => new Promise(resolve => { serviceReady = resolve; });
  manager.bindGuiHost({ send: async () => ({ ok: true }) });
  const startingService = manager.create({ name: 'Starting B service', prompt: 'p', runtime: 'pi', workspaceId: 'ws', rootId: 'b',
    schedule: { kind: 'interval', intervalMinutes: 60 } });
  const serviceRun = manager.runNow(startingService.id);
  await waitFor(() => typeof serviceReady === 'function');
  assert.equal(typeof serviceReady, 'function', JSON.stringify(manager.listRuns(startingService.id)));
  manager.delete(startingService.id); blocked('service');
  serviceReady({ id: 'service-child', workspaceId: 'ws', sourceRoot: source('b') }); await serviceRun;
  assert.equal(manager.rootDependencyRoster().length, 0);
  console.log('ok: deleted service definition retains its immutable starting run as a dependency');

  let probeReady; let probed = false;
  const flow = { config, runtimes, sessions: rows, notify: { push() {} }, usageStats: null,
    agentSessionsRef: { probeRuntime: () => { probed = true; return new Promise(resolve => { probeReady = resolve; }); } },
    isChatRuntime: () => true, applySelectDisplay() {}, persist() {}, broadcast() {},
    get: id => rows.find(session => session.id === id), launchTerminal: async () => {} };
  sessions.createTerminalCtx = () => flow;
  const creating = SessionsService.prototype.createTerminal.call(sessions, { workspaceId: 'ws', rootId: 'b', name: 'Creating B' });
  blocked('launch');
  await waitFor(() => probed);
  assert.equal(probed, true); assert.equal(rows.length, 0); blocked('launch');
  probeReady({ status: 'available', problems: [] });
  const created = await creating; assert.equal(created.sourceRoot.rootId, 'b');
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0); blocked('session'); rows.length = 0;
  await assert.rejects(SessionsService.prototype.createTerminal.call(sessions, { workspaceId: 'ws', rootId: 'b', runtime: 'missing', force: true,
    shellProfileId: 'invalid' }), /未知 Shell/);
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0, 'failed creation releases its reservation');
  console.log('ok: actual creation reserves source before realpath/probe awaits, then transfers to session registration');

  let closeReady;
  const closingId = 'e79ec0de-d09f-4c53-b8d9-542a598f3c1d';
  const closing = { config, notify: { push() {} }, sessions: [{ id: closingId, type: 'terminal', name: 'Closing B', archived: true, runtime: 'pi',
    workspaceId: 'ws', sourceRoot: source('b'), cwd: b, status: 'exited' }],
    rememberEnded() {}, awareness: null, activeId: null, launchTasks: new Map(), launchGen: new Map(), classifyBySession: new Map(),
    ptyWorkingSince: new Map(), notifyBus: { clearSession() {} }, persist() {}, broadcast() {}, notifySessionRemoved() {},
    isChatRuntime: () => true, chatBridge: { close: () => new Promise(resolve => { closeReady = resolve; }) } };
  Object.setPrototypeOf(closing, SessionsService.prototype);
  const closingResult = SessionsService.prototype.close.call(closing, closingId);
  assert.equal(closing.sessions.length, 0); blocked('session'); closeReady(); await closingResult;
  await waitFor(() => workspaceRootUsesFor(config).list('ws').length === 0);
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  console.log('ok: removing a session row does not release its source before driver close completes');

  for (const [target, legacy] of [[{ workspaceId: 'ws', rootId: 'b', relativePath: 'same.txt' }, ''], ['ws', path.join(b, 'same.txt')]]) {
    let releaseOperation;
    const writing = withWorkspaceFileMutation(config, target, legacy, 'file-write', async () => {
      await new Promise(resolve => { releaseOperation = resolve; }); return 'written';
    });
    blocked('file-write');
    await waitFor(() => releaseOperation);
    assert.equal(typeof releaseOperation, 'function'); blocked('file-write');
    cfg.workspaces[0].rootsRevision++;
    cfg.workspaces[0].roots[1].label = 'Renamed while saving';
    releaseOperation(); assert.equal(await writing, 'written');
    cfg.workspaces[0].rootsRevision = 1;
    assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  }
  await assert.rejects(withWorkspaceFileMutation(config, { workspaceId: 'ws', rootId: 'b', relativePath: '../escape' }, '', 'file-delete', async () => {}));
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  console.log('ok: Ref/legacy absolute writes hold their source before validation and through mutation, including failure release');

  const alias = path.join(fixture, 'alias'); fs.symlinkSync(b, alias, 'junction');
  let writeReady;
  const newFileWrite = withWorkspaceFileMutation(config, 'ws', path.join(alias, 'new-file.txt'), 'file-write', async () => {
    await new Promise(resolve => { writeReady = resolve; }); return 'written';
  });
  blocked('file-write'); await waitFor(() => writeReady);
  assert.equal(typeof writeReady, 'function'); blocked('file-write'); writeReady(); await newFileWrite;
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  console.log('ok: creating a new file via a real Junction has no unprotected path-resolution gap');

  registerFsIpc(ctx, {});
  const ref = { workspaceId: 'ws', rootId: 'b', relativePath: 'same.txt' };
  let alive = true;
  const web = { id: 'web:host-issued-one', isAlive: () => alive };
  const other = { id: 'web:host-issued-two', isAlive: () => true };
  assert.deepEqual(await invokeIpcChannel('fs:openFile', [ref, 'view'], web), { ok: true });
  blocked('open-file');
  await invokeIpcChannel('fs:closeFile', ['view'], other); blocked('open-file');
  assert.deepEqual(await invokeIpcChannel('fs:openFile', [{ ...ref, relativePath: '../escape' }, 'bad'], web),
    { ok: false, error: 'invalid workspace relative path' });
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 1);
  assert.equal((await invokeIpcChannel('fs:openFile', [{ ...ref, rootId: 'a', relativePath: '../escape' }, 'view'], web)).ok, false);
  blocked('open-file');
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 1, 'failed replacement preserves the previous valid view');
  const resultCopy = blocked('open-file'); resultCopy.rootDependencies[0].rootId = 'a'; blocked('open-file');
  await invokeIpcChannel('fs:closeFile', ['view'], web);
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  let reached; let resume;
  const verifying = new Promise(resolve => { reached = resolve; });
  const held = new Promise(resolve => { resume = resolve; });
  const realpath = fs.promises.realpath;
  fs.promises.realpath = async (candidate, options) => {
    if (String(candidate) === b) { reached(); await held; }
    return realpath(candidate, options);
  };
  try {
    const pendingOpen = invokeIpcChannel('fs:openFile', [ref, 'pending'], web);
    await Promise.race([verifying, pendingOpen.then(() => { throw new Error('File view validation did not reach the held path'); })]);
    blocked('open-file'); alive = false; workspaceRootUsesFor(config).closeOwner(web.id);
    resume();
    assert.equal((await pendingOpen).ok, false);
  } finally {
    fs.promises.realpath = realpath;
    resume();
  }
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0, 'disconnected validation must not resurrect a view');

  let destroyed; const sender = { id: 9, isDestroyed: () => false, once: (_name, callback) => { destroyed = callback; } };
  assert.equal((await desktopHandlers.get('fs:openFile')({ sender }, ref, 'desktop-view')).ok, true);
  blocked('open-file'); destroyed();
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  console.log('ok: real desktop/Web IPC ownership, cross-client release denial, invalid refs and disconnected opens');

  // Harmless edits are permitted without releasing dependencies or changing their identities.
  const release = holdPendingSource(config, { workspaceId: 'ws', rootId: 'b' }, { kind: 'launch', id: 'edit-test', label: 'B' });
  assert.equal(workspaces.updateMeta('ws', { roots: [...cfg.workspaces[0].roots].reverse(), defaultRootId: 'b', expectedRootsRevision: 1 }).ok, true);
  blocked('launch'); release();
  assert.equal(workspaceRootDependencies(ctx, cfg.workspaces[0]).length, 0);
  const removed = remove(); assert.equal(removed.ok, true); assert.equal(fs.readFileSync(path.join(b, 'same.txt'), 'utf8'), 'b');
  console.log('ok: removal succeeds after explicit release and never deletes the source folder');
  console.log('workspace-root-dependencies: OK');
} finally {
  manager.stop(); queue.resetDelegateQueueForTests();
  const resolvedFixture = path.resolve(fixture);
  if (path.dirname(resolvedFixture) !== path.resolve(os.tmpdir()) || !path.basename(resolvedFixture).startsWith('root-dependencies-')) throw new Error('unexpected cleanup target');
  fs.rmSync(resolvedFixture, { recursive: true, force: true });
}
