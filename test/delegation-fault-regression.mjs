/** Real production adapters/Git; model, brief assembly and task-store boundaries are fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = process.env.DELEGATION_SOURCE_ROOT || project;
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
const originalLoad = Module._load;
let sendFails = false;
Module._load = function(request, parent) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => os.tmpdir(), isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  if (parent?.filename.endsWith(`${path.sep}tasks${path.sep}delegate.ts`)) {
    if (request === '../messages/assignment') return { sendSessionMail: async () => ({stored:true,messageId:'fixture-mail'}) };
    if (request === '../capabilities/hosts/chat') return { buildBriefWithNamedSkills: async (_ctx, _id, task) => ({ brief: task, vocab: [] }), waitTerminalReady: async () => {} };
  }
  return originalLoad.apply(this, arguments);
};
const load = relative => require(path.join(sourceRoot, 'src', relative));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mdf-'));
const oldEnv = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
process.env.GIT_CONFIG_GLOBAL = path.join(fixture, 'empty.gitconfig'); process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function init(dir) {
  fs.mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n'); git(dir, 'add', '.'); git(dir, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'); return dir;
}
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`ok: ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL: ${name}: ${error.stack || error}`); }
}
function ownedRemove(dir) {
  const relative = path.relative(fixture, path.resolve(dir));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
try {
  const sdk = load('main/agentSession/drivers/codex/executable.ts');
  await check('Codex dev and packaged builds require a discovered native CLI without spawning shims', async () => {
    const native = 'C:\\local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
    const options = { platform: 'win32', arch: 'x64', home: 'C:\\home', env: { LOCALAPPDATA: 'C:\\local' }, isExecutable: file => file.toLowerCase() === native.toLowerCase(), packaged: true };
    assert.equal(sdk.resolveUserCodexExecutable(options), native);
    assert.deepEqual(await sdk.resolveCodexExecutable(options), { ok: true, executable: native, packaged: true });
    const chosen = 'C:\\custom\\version.123\\codex.exe';
    assert.equal(sdk.resolveUserCodexExecutable({ ...options, env: { ...options.env, PATH: 'C:\\custom\\version.123' }, isExecutable: file => [native, chosen].includes(file) }), chosen);
    const npmExe = 'C:\\roaming\\npm\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
    const npm = { ...options, env: { APPDATA: 'C:\\roaming', PATH: 'C:\\roaming\\npm' }, isExecutable: file => [npmExe, 'C:\\roaming\\npm\\codex.cmd', 'C:\\roaming\\npm\\codex'].includes(file) };
    assert.equal(sdk.resolveUserCodexExecutable(npm), npmExe);
    assert.equal(sdk.resolveUserCodexExecutable({ ...npm, isExecutable: file => file.endsWith('codex.cmd') }), null);
    const officialBare = 'C:\\local\\Programs\\OpenAI\\Codex\\bin\\codex';
    assert.equal(sdk.resolveUserCodexExecutable({ ...options, isExecutable: file => file === officialBare }), officialBare);
    assert.equal(sdk.resolveUserCodexExecutable({
      ...options,
      env: {},
      isExecutable: file => file === 'C:\\roaming\\npm\\codex.exe',
      lookupOnPath: () => ['C:\\roaming\\npm\\codex.cmd']
    }), 'C:\\roaming\\npm\\codex.exe');
    assert.deepEqual(await sdk.resolveCodexExecutable({ ...options, isExecutable: () => false }), { ok: false, packaged: true });
    assert.deepEqual(await sdk.resolveCodexExecutable({ ...options, packaged: false }), { ok: true, executable: native, packaged: false });
    assert.deepEqual(await sdk.resolveCodexExecutable({ ...options, packaged: false, isExecutable: () => false }), { ok: false, packaged: false });
  });

  const nested = load('main/git/nestedRepos.ts');
  await check('empty repoSet cannot widen into healthy or broken nested repositories', () => {
    const discovery = { healthy: ['Plugins/Child'], skipped: [{ path: 'refs/broken', reason: 'missing-head', detail: 'fixture' }] };
    assert.deepEqual(nested.selectHealthyNestedTargets(discovery, []).targets, []);
    assert.deepEqual(nested.selectHealthyNestedTargets(discovery).targets, ['Plugins/Child']);
    assert.deepEqual(nested.buildNestedRepoBriefNote({ repoSet: [], discovered: discovery.healthy }), '');
  });

  const { GitRepoDiscoveryCache } = load('main/git/discoveryCache.ts');
  const main = init(path.join(fixture, 'scan'));
  init(path.join(main, '.tmp/test-transient')); const child = init(path.join(main, 'Plugins/Child'));
  const linked = path.join(main, 'scratch/linked'); git(main, 'worktree', 'add', '-q', '-b', 'linked-fixture', linked);
  const cache = new GitRepoDiscoveryCache();
  await check('temporary repos and linked checkouts cannot enter automatic nested isolation', async () => {
    assert.deepEqual((await cache.nested(main)).healthy, ['Plugins/Child']);
    assert.deepEqual((await nested.discoverNestedReposDetailed(main)).healthy, ['Plugins/Child']);
    assert((await cache.roots(main)).includes(linked), 'linked checkout remains visible in Git');
  });
  await check('deleted cached candidates are never healthy and cannot fall back to the parent repo', async () => {
    await cache.nested(main); ownedRemove(child);
    const result = await cache.nested(main);
    assert(!result.healthy.includes('Plugins/Child'));
    assert(result.skipped.some(repo => repo.path === 'Plugins/Child' && repo.reason === 'missing-directory'));
    assert(!(await cache.roots(main)).includes(child));
    assert.equal(nested.selectHealthyNestedTargets(result, ['Plugins/Child']).ok, false);
  });
  await check('replacement of a cached Git directory requires refresh', async () => {
    const base = init(path.join(fixture, 'identity')), repo = init(path.join(base, 'Plugins/Changed'));
    const identityCache = new GitRepoDiscoveryCache(); await identityCache.nested(base);
    fs.renameSync(path.join(repo, '.git'), path.join(fixture, 'old-git'));
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    git(repo, 'add', '.'); git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'replacement');
    const result = await identityCache.nested(base);
    assert(!result.healthy.includes('Plugins/Changed'));
    assert(result.skipped.some(repo => repo.reason === 'identity-changed'));
    await identityCache.roots(base, true); assert((await identityCache.nested(base)).healthy.includes('Plugins/Changed'));
  });

  const { GitService } = load('main/git/service.ts');
  const { createTaskWorktreeGroups } = load('main/git/worktreeTaskCreate.ts');
  const { resolveSessionTarget } = load('main/sessions/targets.ts');
  const { readWorktreePreparation, saveWorktreePreparation } = load('main/git/worktreePreparationSettings.ts');
  const { preparationsForSelections } = load('shared/worktreePreparation.ts');
  const source = init(path.join(fixture, 'source')), plugin = init(path.join(source, 'Plugins/Child')), reference = init(path.join(source, 'refs/reference'));
  const workspace = { id: 'ws', path: source, controlRoot: source, roots: [{ id: 'source', path: source }], defaultRootId: 'source', rootsRevision: 1, openedAt: 0 };
  const cfg = { defaultRuntime: 'pi', workspace: source, activeWorkspaceId: 'ws', worktreeStorageRoot: path.join(fixture, 'managed'), workspaces: [workspace] };
  const config = { get: () => cfg }, service = new GitService(config);
  const beforeRefs = git(source, 'show-ref'), beforeIndex = fs.readFileSync(path.join(source, '.git/index'));
  await check('repository discovery reads preferences without creating or migrating source files', async () => {
    await service.discoverNestedReposDetailedFor(source);
    assert(!fs.existsSync(path.join(source, '.muster')));
    const { readWorkspaceFile } = load('main/metaAgent/workspaceFile.ts');
    const prefsRoot = path.join(fixture, 'read-only-prefs'); fs.mkdirSync(path.join(prefsRoot, '.muster'), { recursive: true });
    const prefsFile = path.join(prefsRoot, '.muster/workspace.json'); fs.writeFileSync(prefsFile, '{"git":{}}');
    readWorkspaceFile(prefsRoot, { readonly: true }); assert.equal(fs.readFileSync(prefsFile, 'utf8'), '{"git":{}}');
    fs.writeFileSync(prefsFile, '{broken'); assert.throws(() => readWorkspaceFile(prefsRoot, { readonly: true }), /JSON|parse/);
    assert.equal(fs.readFileSync(prefsFile, 'utf8'), '{broken');
  });
  await check('legacy and grouped creation preserve primary-only empty selection without nested discovery', async () => {
    const original = service.discoverNestedReposDetailedFor;
    service.discoverNestedReposDetailedFor = async () => { throw Error('explicit empty selection must not scan nested repos'); };
    try {
      const legacy = await service.addSessionWorktreeGroup(source, 'empty001-fixture', []);
      assert.equal(legacy.ok, true, legacy.message); assert.deepEqual(legacy.repos, []);
      const target = await resolveSessionTarget(cfg, { workspaceId: 'ws', rootId: 'source', cwd: source });
      const grouped = await createTaskWorktreeGroups({ config, git: service }, { target, sessionId: 'empty002-fixture', selections: [{ rootId: 'source', relativePath: '', repoSet: [] }], provisionCommands: [] });
      assert.equal(grouped.ok, true, grouped.message); assert.deepEqual(grouped.state.groups[0].repos, []);
      assert.deepEqual(preparationsForSelections([{ rootId: 'source', relativePath: 'Plugins/Child', commands: ['must not run'] }], [{ rootId: 'source', relativePath: '', repoSet: [] }]), []);
    } finally { service.discoverNestedReposDetailedFor = original; }
    assert.equal(git(plugin, 'branch', '--list', 'ao/empty*'), ''); assert.equal(git(reference, 'branch', '--list', 'ao/empty*'), '');
    assert(!fs.existsSync(path.join(source, '.git/info/exclude')) || !fs.readFileSync(path.join(source, '.git/info/exclude'), 'utf8').includes('/Plugins/Child/'));
  });
  await check('saved reference exclusions affect auto isolation, explicit selections override them', async () => {
    const saved = saveWorktreePreparation(cfg, { ...readWorktreePreparation(cfg, 'ws'), exclusions: [{ rootId: 'source', relativePath: 'refs/reference' }] });
    assert.deepEqual(saved.exclusions, [{ rootId: 'source', relativePath: 'refs/reference' }]);
    assert.deepEqual((await service.discoverNestedReposDetailedFor(source)).healthy, ['Plugins/Child']);
    assert((await service.listRepoLocations(false, 'ws')).repos.some(repo => repo.path === reference));
    const automatic = await service.addSessionWorktreeGroup(source, 'exclude1-fixture');
    assert.equal(automatic.ok, true, automatic.message); assert.deepEqual(automatic.repos.map(repo => repo.path), ['Plugins/Child']);
    const explicit = await service.addSessionWorktreeGroup(source, 'exclude2-fixture', ['refs/reference']);
    assert.equal(explicit.ok, true, explicit.message); assert.deepEqual(explicit.repos.map(repo => repo.path), ['refs/reference']);
    const oldCaller = { ...saved, commands: ['echo updated'] }; delete oldCaller.exclusions;
    assert.deepEqual(saveWorktreePreparation(cfg, oldCaller).exclusions, saved.exclusions, 'older save callers preserve exclusions');
    assert.equal(git(source, 'show-ref').split('\n').filter(line => !line.includes('refs/heads/ao/')).join('\n'), beforeRefs);
    assert.deepEqual(fs.readFileSync(path.join(source, '.git/index')), beforeIndex);
  });

  const { createSessionWithTask } = load('main/capabilities/hosts/creation.ts');
  const queue = load('main/tasks/delegateQueue.ts'); queue.resetDelegateQueueForTests();
  let createInput, liveFailure, sentOk = true;
  const rows = [];
  const ctx = { config, git: service, resolveBubbleWorkspaceId: () => 'ws',
    sessions: { listByWorkspace: () => rows, list: () => rows, isChatRuntime: () => true, injectStrategy: async () => 'initial-prompt',
      createTerminal: async input => { createInput = input; const row = { id: `delegate-${rows.length}`, name: 'fixture', type: 'terminal', workspaceId: 'ws', cwd: source, sourceRoot: input.capturedSource, worktreeRepoSet: [] }; rows.push(row); return row; },
      get: id => rows.find(row => row.id === id), ensureStatusToken() {}, clearDonePhase() {}, setLiveStatus(_id, live) { if (live.kind === 'error') liveFailure = live; } },
    agentSessions: { send: async () => {
      // 新建 GUI 会话的首个任务现在直接经 chat 投递，故障要注入这一层；
      // sendSessionMail 只剩复用会话/CLI 分支，旧的 mailbox 注入点钩不到这条路径。
      if (sendFails) return { ok: false, error: 'fixture mailbox failure' };
      return { ok: sentOk, error: sentOk ? undefined : 'fixture send refusal' };
    } }
  };
  const isolationGroups = [{rootId:'source',relativePath:'',repoSet:[]}];
  await check('public creation passes explicit source groups and preserves empty nested selection', async () => {
    const result = await createSessionWithTask(ctx, { task: 'fixture task', isolation: 'isolated', isolationGroups, select: false });
    assert.deepEqual(createInput.isolationGroups, isolationGroups); assert.equal(createInput.repoSet, undefined); assert.deepEqual(result.repoSet, []); assert.equal(result.status, 'started');
  });
  await check('GUI first-task send failure preserves the created resource identity without reporting started', async () => {
    sendFails = true;
    try { await createSessionWithTask(ctx, {task:'fixture task',isolation:'isolated',isolationGroups,select:false}); assert.fail('must reject'); }
    catch(error) { assert.match(error.message,/fixture mailbox failure/);assert.equal(error.sessionId,'delegate-1'); }
    sendFails = false;
  });

  const inbound = load('shared/inboundMcp.ts');
  await check('MCP tool exceptions and absent results produce a correlated error response', async () => {
    const request = { jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'sessions_create', arguments: {} } };
    for (const callTool of [async () => { throw Error('fixture failure'); }, async () => undefined]) {
      const reply = await inbound.handleInboundMcpMessage(request, { tools: [], callTool });
      assert.equal(reply.id, 71); assert.equal(reply.result.isError, true); assert(reply.result.content[0].text.startsWith('sessions_create:'));
      assert(Object.hasOwn(JSON.parse(JSON.stringify(reply)), 'result'));
    }
    const refused = await inbound.dispatchInboundMcpTool('sessions_create', {}, { token: 'fixture', statusUrl: 'fixture', toolUrl: 'fixture' },
      { postJson: async () => ({ ok: true, status: 200, text: '{"ok":false,"error":"fixture preflight"}' }) }, ['sessions.create']);
    assert.equal(refused.isError, true); assert(refused.content[0].text.includes('fixture preflight'));
  });

  if (process.platform === 'win32') await check('host Git long-path checkout succeeds without changing Git configuration', async () => {
    const repo = init(path.join(fixture, 'long'));
    const relative = ['a'.repeat(45), 'b'.repeat(45), 'c'.repeat(35) + '.txt'].join('/');
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true }); fs.writeFileSync(path.join(repo, relative), 'fixture\n');
    git(repo, 'add', '.'); git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'long fixture');
    git(repo, 'config', 'core.longpaths', 'false'); const configBefore = fs.readFileSync(path.join(repo, '.git/config'));
    const target = path.join(fixture, 'target', 'd'.repeat(45), 'e'.repeat(45), 'f'.repeat(45), 'tree');
    const { createHostGitClient } = load('main/git/hostGitClient.ts');
    await createHostGitClient(repo, process.env).raw(['worktree', 'add', '--detach', target, 'HEAD']);
    assert(fs.existsSync(path.join(target, relative)));
    await createHostGitClient(repo, process.env).raw(['worktree', 'remove', '--force', target]);
    assert.deepEqual(fs.readFileSync(path.join(repo, '.git/config')), configBefore);
  });
  queue.resetDelegateQueueForTests();
  assert.deepEqual(failures, [], `failed scenarios: ${failures.join(', ')}`);
} finally {
  Module._load = originalLoad;
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];
  for (const [key, value] of Object.entries(oldEnv)) if (key.startsWith('GIT_')) process.env[key] = value;
  const relative = path.relative(os.tmpdir(), fixture); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
