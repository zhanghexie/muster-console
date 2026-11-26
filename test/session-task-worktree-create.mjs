/** Production session entry point + real Git; only engine opening is a fixture boundary. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript'), Module = require('node:module');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
const originalLoad = Module._load;
Module._load = function(request) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const { SessionsService } = require(path.join(project, 'src/main/sessions.ts'));
const { GitService } = require(path.join(project, 'src/main/git/service.ts'));
const { workspaceRootUsesFor } = require(path.join(project, 'src/main/workspaceRootUses.ts'));
const { captureWorkspaceExecutionContext } = require(path.join(project, 'src/main/workspaceExecutionContext.ts'));
const tempRoot = path.join(project, '.tmp'); fs.mkdirSync(tempRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(tempRoot, 'session-task-worktree-create-'));
const crossDriveFixture = process.env.TEST_WORKTREE_STORAGE_OTHER_DRIVE === '1' ? fs.mkdtempSync(path.join(os.tmpdir(), 'session-task-worktree-cross-drive-')) : undefined;
if (crossDriveFixture) assert.notEqual(path.parse(crossDriveFixture).root.toLowerCase(), path.parse(fixture).root.toLowerCase(), 'cross-drive proof requires different actual volumes');
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const a = path.join(fixture, 'a'), b = path.join(fixture, 'b');
  for (const folder of [a, b]) {
    fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
    git(folder, 'init', '-q', '-b', 'main');
    git(folder, 'config', 'user.name', 'Fixture'); git(folder, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(folder, 'src', 'same.txt'), 'baseline');
    git(folder, 'add', '.'); git(folder, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  }
  const cfg = { defaultRuntime: 'pi', workspace: b, activeWorkspaceId: 'ws', worktreeStorageRoot: crossDriveFixture ?? path.join(fixture, 'managed'),
    workspaces: [{ id: 'ws', name: 'Multi', path: b, controlRoot: a, defaultRootId: 'b', rootsRevision: 1, roots: [{ id: 'a', path: a }, { id: 'b', path: b }] }] };
  const config = { get: () => cfg }, gitService = new GitService(config), rows = [], launches = [], notices = [];
  const { readWorktreePreparation, saveWorktreePreparation } = require(path.join(project, 'src/main/git/worktreePreparationSettings.ts'));
  const preparationTrace = path.join(fixture, 'preparation.ndjson'), preparationScript = path.join(fixture, 'prepare.cjs');
  fs.writeFileSync(preparationScript, `const fs=require('node:fs'),path=require('node:path');
const groups=JSON.parse(process.env.MUSTER_WORKTREE_GROUPS_JSON);
for(const group of groups) if(!fs.existsSync(path.join(group.worktreePath,'.git'))) throw Error('group missing before preparation');
fs.appendFileSync(${JSON.stringify(preparationTrace)},JSON.stringify({tag:process.argv[2],cwd:process.cwd(),groups})+'\\n');`);
  const preparationCommand = tag => `"${process.execPath}" "${preparationScript}" ${tag}`;
  saveWorktreePreparation(cfg, { ...readWorktreePreparation(cfg, 'ws'), commands: [preparationCommand('workspace')],
    recipes: [{ rootId: 'b', relativePath: '', commands: [preparationCommand('b')] }] });
  assert.equal(fs.existsSync(preparationTrace), false, 'saving settings never executes commands');
  let releaseProbe, enteredProbe;
  const probeEntered = new Promise(resolve => { enteredProbe = resolve; });
  const probeGate = new Promise(resolve => { releaseProbe = resolve; });
  const flow = { config, git: gitService, runtimes: { get: () => ({ enabled: true, surface: 'chat' }) }, sessions: rows,
    isChatRuntime: () => true, notify: { push: notice => notices.push(notice) }, usageStats: null,
    agentSessionsRef: { async probeRuntime() { enteredProbe(); await probeGate; return { status: 'available', problems: [] }; } },
    applySelectDisplay() {}, persist() {}, broadcast() {}, get: id => rows.find(row => row.id === id),
    async launchTerminal(session) { launches.push(captureWorkspaceExecutionContext(cfg, session, rows)); }
  };
  const service = { config, sessions: rows, createTerminalCtx: () => flow, isChatRuntime: () => false };
  const create = opts => SessionsService.prototype.createTerminal.call(service, opts);
  const selections = [{ rootId: 'a', relativePath: '' }, { rootId: 'b', relativePath: '' }];
  const starting = create({ workspaceId: 'ws', rootId: 'a', cwd: path.join(a, 'src'), isolate: true, isolationGroups: selections });
  assert.deepEqual(workspaceRootUsesFor(config).list('ws').map(use => use.rootId).sort(), ['a', 'b'], 'source validation itself holds every selected root');
  await probeEntered;
  assert.deepEqual(workspaceRootUsesFor(config).list('ws').map(use => use.rootId).sort(), ['a', 'b'], 'runtime probing cannot expose a removable secondary root');
  selections[1].rootId = 'not-registered'; // In-flight input is a snapshot.
  releaseProbe(); const session = await starting;
  assert.equal(session.worktreeGroups.groups.length, 2); assert.equal(session.sourceRoot.rootId, 'a');
  assert.equal(session.cwd, path.join(a, 'src'));
  assert.equal(session.worktreeGroups.cwdPolicy, 'source');
  assert.equal(rows.length, 1); assert.equal(launches.length, 1); assert.equal(launches[0].writableDirectories.length, 4);
  assert.equal(launches[0].cwd, session.cwd); assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  assert.equal(JSON.stringify(session).includes('assertCurrent'), false, 'host transaction guards are never persisted');
  const secondary = session.worktreeGroups.groups.find(group => group.sourceRoot.rootId === 'b');
  const prepared = fs.readFileSync(preparationTrace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(prepared.map(row => row.tag), ['workspace', 'b']);
  const physicalKey = value => fs.realpathSync(value).replace(/\\/g, '/').toLowerCase();
  assert.deepEqual(prepared.map(row => physicalKey(row.cwd)), [session.worktreePath, secondary.path].map(physicalKey));
  assert.ok(prepared.every(row => row.groups.length === 2), 'persisted recipes run only after all groups exist');
  assert.equal(fs.existsSync(path.join(a, 'preparation.ndjson')), false); assert.equal(fs.existsSync(path.join(b, 'preparation.ndjson')), false);
  const borrowed = await create({ workspaceId: 'ws', sourceSessionId: session.id, cwd: path.join(secondary.path, 'src'), force: true });
  assert.equal(borrowed.sourceRoot.rootId, 'b', 'actual service borrowing a secondary tree must not inherit the primary source');
  assert.equal(borrowed.worktreeGroups, undefined, 'borrowing does not transfer cleanup ownership');
  assert.equal(launches.at(-1).writableDirectories.length, 2);
  // The production integrate entry must route the whole saved collection, not its projection.
  for (const group of session.worktreeGroups.groups) {
    fs.writeFileSync(path.join(group.path, 'src', 'same.txt'), `integrated-${group.sourceRoot.rootId}`);
    git(group.path, 'add', '.'); git(group.path, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'task change');
  }
  const phases = [], acceptances = [], savedMerges = [];
  service.integrateCtx = () => ({ config, git: gitService, notify: flow.notify, awareness: null,
    workspaceIdFor: () => 'ws', resolveWorkspaceId: () => 'ws', findSession: id => rows.find(row => row.id === id), sessions: () => rows,
    persist: () => savedMerges.push(structuredClone(session)), broadcast() {}, emitRuntimeFacts() {},
    setPhase: (_id, phase) => phases.push(phase), setLiveStatus() {},
    recordAcceptance: (_id, record) => acceptances.push(record),
    setArchived() {}, archiveReleaseThenCleanup() {}
  });
  const approvalRequests = [];
  service.git = gitService;
  service.get = id => rows.find(row => row.id === id);
  service.approvalSnapshot = SessionsService.prototype.approvalSnapshot;
  service.businessApproval = async (workspaceId, action, args, evidence, gitEvidence) => {
    approvalRequests.push({workspaceId,action,args,evidence});
    assert.equal(workspaceId,'ws');assert.equal(action,'sessions.integrateWorktree');
    assert.equal(args.sessionId,session.id);assert.match(evidence,/integrated-/);
    assert.equal(gitEvidence.kind,'git');assert.equal(gitEvidence.incomplete,false,JSON.stringify(gitEvidence.repositories.map(({root,unavailable,content})=>({root,unavailable,parts:Object.keys(content)}))));
    assert.ok(gitEvidence.repositories.length>=4,'all task worktrees and their target repositories are captured');
    assert.match(Object.values(gitEvidence.contents).join('\n'),/integrated-a/);
    assert.match(Object.values(gitEvidence.contents).join('\n'),/integrated-b/);
    return true;
  };
  const integrated = await SessionsService.prototype.integrateWorktree.call(service, session.id, { skipNpmInstall: true, skipTypecheck: true });
  assert.equal(approvalRequests.length,1,'production integration obtains exactly one business approval before all-group merge');
  assert.equal(integrated.merged, true); assert.equal(integrated.groups.length, 2); assert.equal(integrated.cleanup, 'scheduled');
  assert.equal(phases.length, 1); assert.equal(acceptances.length, 1);
  for (const group of session.worktreeGroups.groups) {
    assert.equal(fs.readFileSync(path.join(group.source.mainRepo, 'src', 'same.txt'), 'utf8'), `integrated-${group.sourceRoot.rootId}`);
    assert.equal(group.integration[0].status, 'merged');
  }
  assert.ok(savedMerges.length >= 4, 'task outcomes persist through the actual service entry');
  const { cleanupTaskWorktrees } = require(path.join(project, 'src/main/git/worktreeTaskCleanup.ts'));
  rows.find(row => row.id === borrowed.id).archived = true;
  assert.equal((await cleanupTaskWorktrees(service.integrateCtx(), session, 'archive')).ok, true, 'actual create and integrate are followed by all-group cleanup');
  assert.equal(session.worktreeGroups, undefined); assert.equal(session.cwd, path.join(a, 'src'));
  rows.length = 0;
  // Existing single-group public requests also consume matching repository settings.
  const compatible = await create({ workspaceId: 'ws', rootId: 'b', isolate: true, force: true });
  const allPrepared = fs.readFileSync(preparationTrace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(allPrepared.map(row => row.tag), ['workspace', 'b', 'workspace', 'b']);
  assert.equal(compatible.worktreeGroups.groups.length, 1);
  assert.ok(allPrepared.slice(2).every(row => physicalKey(row.cwd) === physicalKey(compatible.worktreePath) && row.groups.length === 1));
  // This assertion covers legacy preparation; its owned single tree uses the single-tree removal API.
  assert.equal((await gitService.worktreeRemove(compatible.worktreePath)).ok, true);
  git(b, 'branch', '-D', compatible.worktreeBranch);
  rows.length = 0;
  for (const options of [
    { isolate: false, isolationGroups: [{ rootId: 'a', relativePath: '' }] },
    { isolate: true, repoSet: [], isolationGroups: [{ rootId: 'a', relativePath: '' }] },
    { isolate: true, shellProfileId: 'powershell', isolationGroups: [{ rootId: 'a', relativePath: '' }] },
    { isolate: true, isolationGroups: [] }
  ]) await assert.rejects(create({ workspaceId: 'ws', force: true, ...options }), /isolationGroups/);
  assert.equal(rows.length, 0); assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);

  // A later group's failure never publishes a primary-only session or starts an engine.
  const originalMaterialize = gitService.materializeSessionWorktreeGroup.bind(gitService); let count = 0;
  const previousNotices = notices.length;
  gitService.materializeSessionWorktreeGroup = async (...args) => ++count === 2 ? { ok: false, message: 'session second-group fixture failure' } : originalMaterialize(...args);
  await assert.rejects(create({ workspaceId: 'ws', rootId: 'a', force: true, isolate: true,
    isolationGroups: [{ rootId: 'a', relativePath: '' }, { rootId: 'b', relativePath: '' }] }), /second-group/);
  assert.equal(rows.length, 0); assert.equal(launches.length, 3);
  for (const folder of [a, b]) assert.equal(git(folder, 'for-each-ref', '--format=%(refname)', 'refs/heads/ao/'), '');
  assert.equal(workspaceRootUsesFor(config).list('ws').length, 0);
  assert.equal(notices.length, previousNotices, 'successful rollback needs no retained-resource warning');
  // The model-facing default must reach the real session service and create only cwd's repository.
  const { sessionsHost } = require(path.join(project, 'src/main/capabilities/hosts/sessions.ts'));
  const hostCtx = { config, git: gitService, resolveBubbleWorkspaceId: () => 'ws',
    sessions: { listByWorkspace: () => rows, isChatRuntime: () => true, createTerminal: create } };
  const preset = await sessionsHost['sessions.create'](hostCtx, {
    workspaceId: 'ws', rootId: 'b', cwd: path.join(b, 'src'), isolation: 'isolated', force: true, select: false
  });
  assert.equal(preset.worktreeGroups.groups.length, 1);
  assert.equal(physicalKey(preset.worktreeGroups.groups[0].source.mainRepo), physicalKey(b));
  assert.equal(fs.existsSync(path.join(preset.worktreePath, '.git')), true);
  assert.equal(preset.cwd, path.join(b, 'src'));
  assert.equal((await gitService.worktreeRemove(preset.worktreePath)).ok, true);
  git(b, 'branch', '-D', preset.worktreeBranch);
  console.log('ok session-task-worktree-create: actual create/integrate entries, all-group disk merge/results, row/launch, leases, input snapshot, cwd, metadata and failed-group no-publication');
} finally {
  Module._load = originalLoad;
  assert.ok(path.resolve(fixture).startsWith(path.resolve(tempRoot) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
  if (crossDriveFixture) {
    const target = path.resolve(crossDriveFixture);
    assert.ok(target.startsWith(`${path.resolve(os.tmpdir())}${path.sep}session-task-worktree-cross-drive-`));
    fs.rmSync(target, { recursive: true, force: true });
  }
}
