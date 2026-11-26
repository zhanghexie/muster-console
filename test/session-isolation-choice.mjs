/** Model choices are required before side effects and survive queue snapshots. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isolation-choice-'));
const compile = createSharedCompiler(process.cwd(), tmp);
// delegateTask imports Electron's app; this offline fixture does not run Electron.
const electronShim = path.join(tmp, 'node_modules', 'electron');
fs.mkdirSync(electronShim, { recursive: true });
fs.appendFileSync(path.join(electronShim, 'index.cjs'), `module.exports.app.getPath = () => ${JSON.stringify(tmp)};\n`);
const load = name => import(pathToFileURL(compile(name)).href);
let queue;
try {
  const { sessionsHost } = await load('main/capabilities/hosts/sessions.ts');
  const { createSessionWithTask } = await load('main/capabilities/hosts/creation.ts');
  const { delegateTask } = await load('main/tasks/delegate.ts');
  const { TOOL_DEFS } = await load('main/capabilities/catalog.ts');
  const { sourceRootsFor } = await load('main/workspacePaths.ts');
  const { runAsAgentSession } = await load('main/agent/agentScope.ts');
  queue = await load('main/tasks/delegateQueue.ts');
  for (const name of ['sessions.create', 'runs.delegate']) {
    const schema = TOOL_DEFS.find(tool => tool.name === name).parameters;
    assert.ok(schema.required.includes('isolation'), name);
    assert.deepEqual(schema.properties.isolation.enum, ['shared', 'isolated']);
    assert.equal(schema.properties.isolation.default, undefined);
    assert.ok(schema.properties.isolationGroups.items.required.includes('repoSet'));
  }
  const piAiEntry = path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js');
  const { validateToolArguments } = await import(fs.existsSync(piAiEntry) ? pathToFileURL(piAiEntry).href : import.meta.resolve('@earendil-works/pi-ai'));
  const createDef = TOOL_DEFS.find(tool => tool.name === 'sessions.create');
  validateToolArguments(createDef, { name: createDef.name, arguments: { task: 'work', isolation: 'isolated' } });
  assert.throws(() => validateToolArguments(createDef, { name: createDef.name, arguments: { isolation: 'isolated', isolationGroups: [{ rootId: 'root', relativePath: '' }] } }), /Validation failed/);
  const group = { rootId: 'root', relativePath: '', repoSet: [] };
  const invalid = [
    {}, { isolation: 'auto' }, { isolation: null }, { isolation: false },
    { isolation: 'shared', isolationGroups: [] },
    { isolation: 'isolated', isolationGroups: [] },
    { isolation: 'isolated', isolationGroups: [{ rootId: 'root', relativePath: '' }] },
    { isolation: 'isolated', isolationGroups: [{ ...group, repoSet: null }] },
    { isolation: 'isolated', isolationGroups: [null] },
    { isolation: 'isolated', isolationGroups: [group], shellProfileId: 'shell' }
  ];
  // Any context access would mean validation happened after a side effect could start.
  const untouched = new Proxy({}, { get() { throw Error('context accessed before isolation validation'); } });
  for (const choice of invalid) {
    for (const extra of [{}, { task: 'work' }, { asSubagent: true, task: 'work' }]) {
      await assert.rejects(async () => sessionsHost['sessions.create'](untouched, { ...choice, ...extra }), /isolation|repoSet|Shell/);
    }
    await assert.rejects(async () => createSessionWithTask(untouched, { ...choice, task: 'work' }), /isolation|repoSet|Shell/);
  }
  for (const isolate of [undefined, 'auto', 'true', null]) {
    await assert.rejects(delegateTask(untouched, { task: 'work', isolate }), /isolate 必须/);
    assert.throws(() => queue.enqueueDelegate(untouched, 'ws', { task: 'work', isolate }), /isolate 必须/);
  }

  const workspace = { id: 'ws', path: tmp };
  const rootId = sourceRootsFor(workspace)[0].id;
  const created = [];
  const ctx = { resolveBubbleWorkspaceId: () => 'ws',
    config: { get: () => ({ workspaces: [workspace], workspace: tmp }) },
    git: { probeDirty() { throw Error('execution must never select isolation from dirty'); } },
    sessions: { listByWorkspace: () => [], isChatRuntime: () => false, createTerminal: async input => { created.push(input); return { id: 'created' }; } }
  };
  await sessionsHost['sessions.create'](ctx, { isolation: 'shared' });
  await sessionsHost['sessions.create'](ctx, { isolation: 'isolated', isolationGroups: [{ rootId, relativePath: '', repoSet: [] }] });
  assert.deepEqual(created.map(input => input.isolate), [false, true]);
  assert.deepEqual(created[1].isolationGroups[0].repoSet, []);

  const repo = path.join(tmp, 'repo');fs.mkdirSync(repo);
  ctx.git.resolveMainRepoFor = async (cwd, ceiling) => {
    assert.equal(cwd, repo);assert.equal(ceiling, tmp);return repo;
  };
  await sessionsHost['sessions.create'](ctx, { isolation: 'isolated', cwd: repo });
  assert.deepEqual(created[2].isolationGroups, [{ rootId, relativePath: 'repo', repoSet: [] }], 'default selects only the cwd repository');
  ctx.git.resolveMainRepoFor = async () => null;
  await assert.rejects(() => sessionsHost['sessions.create'](ctx, { isolation: 'isolated', cwd: repo }), /Git|仓库/);
  assert.equal(created.length,3,'a missing repository cannot create or silently fall back to shared');
  ctx.git.resolveMainRepoFor = async () => os.tmpdir();
  await assert.rejects(() => sessionsHost['sessions.create'](ctx, { isolation: 'isolated', cwd: repo }), /Git|仓库/);
  assert.equal(created.length,3,'a repository outside the selected root cannot be isolated by default');
  ctx.git.resolveMainRepoFor = async () => { workspace.path = repo;return repo; };
  await assert.rejects(() => sessionsHost['sessions.create'](ctx, { isolation: 'isolated', cwd: repo }), /changed|removed/);
  workspace.path = tmp;

  const alias = path.join(tmp, 'repo-alias');fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  workspace.path = alias;ctx.git.resolveMainRepoFor = async () => repo;
  const aliasRootId = sourceRootsFor(workspace)[0].id;
  await sessionsHost['sessions.create'](ctx, { isolation: 'isolated' });
  assert.deepEqual(created[3].isolationGroups, [{ rootId: aliasRootId, relativePath: '', repoSet: [] }], 'physical aliases resolve to the selected root');
  workspace.path = tmp;

  // The same default is captured before a child task enters the concurrency queue.
  queue.resetDelegateQueueForTests();
  ctx.git.resolveMainRepoFor = async () => repo;
  const parent = { id: 'parent', workspaceId: 'ws', type: 'terminal', lifecycle: 'working' };
  let active = Array.from({length: 50}, () => ({ type: 'terminal', lifecycle: 'working' }));
  ctx.sessions.get = id => id === 'parent' ? parent : undefined;
  ctx.sessions.listByWorkspace = () => active;
  const admission = await runAsAgentSession('parent', () => sessionsHost['sessions.create'](ctx, {
    isolation: 'isolated', cwd: repo, task: 'child task', asSubagent: true
  }));
  assert.equal(admission.queued,true);
  active = [];
  let defaultQueued;
  queue.bindDelegateRunner(async (_ctx, value) => { defaultQueued = value;return { notified: false }; });
  await queue.drainDelegateQueue('ws');
  assert.deepEqual(defaultQueued.isolationGroups, [{ rootId, relativePath: 'repo', repoSet: [] }]);
  assert.equal(defaultQueued.parentSessionId,'parent');

  queue.resetDelegateQueueForTests();
  const input = { task: 'frozen choice', runtime: 'codex', cliLaunchOptions: { model: 'test-model', permission: 'ask' }, isolate: true, isolationGroups: [{ rootId, relativePath: '', repoSet: [] }] };
  queue.enqueueDelegate(ctx, 'ws', input);
  input.isolate = false;
  input.cliLaunchOptions.model = 'late-change';
  input.isolationGroups[0].repoSet.push('late-change');
  let drained;
  queue.bindDelegateRunner(async (_ctx, value) => { drained = value; return { notified: false }; });
  await queue.drainDelegateQueue('ws');
  assert.equal(drained.isolate, true, 'queue retains the submitted decision');
  assert.deepEqual(drained.cliLaunchOptions, { model: 'test-model', permission: 'ask' }, 'queue freezes CLI launch options');
  assert.deepEqual(drained.isolationGroups[0].repoSet, [], 'queue retains the submitted repository scope');
  console.log('session-isolation-choice: required decisions, fail-before-side-effects, explicit scope and frozen queue passed');
} finally {
  queue?.resetDelegateQueueForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
}
