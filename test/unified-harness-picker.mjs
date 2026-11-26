import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-harness-picker-'));
const profile = path.join(tmp, 'profile');
const source = path.join(tmp, 'source');
const nested = path.join(source, 'nested');
const worktree = path.join(tmp, 'task-worktree');
for (const directory of [profile, nested, worktree]) fs.mkdirSync(directory, { recursive: true });
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('node:module');
const originalLoad = Module._load;
const compile = (source, filename) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText;
require.extensions['.ts'] = (module, filename) => module._compile(compile(fs.readFileSync(filename, 'utf8'), filename), filename);
Module._load = function (name, parent) {
  if (name === 'electron') return { app: { getPath: () => profile, isReady: () => true, isPackaged: false }, ipcMain: { on() {}, handle() {} } };
  if (name === './claudeSdk' && parent?.filename.endsWith(path.join('claude', 'models.ts'))) return {
    resolveUserClaudeExecutable: () => null,
    loadClaudeSdk: async () => { throw new Error('Fixture forbids external Claude discovery'); },
    resolveClaudeExecutable: async () => { throw new Error('Fixture forbids external Claude executable resolution'); }
  };
  return originalLoad.apply(this, arguments);
};
const load = entry => require(path.join(root, 'src', entry));

try {
  const { configureModelCatalogStorage, ModelCatalogCache } = load('main/agentSession/modelCatalogCache.ts');
  const claude = load('main/agentSession/drivers/claude/models.ts');
  const originalClaudeRead = claude.listClaudeModels;
  const { Store } = load('main/store.ts');
  const { userDataStorage } = load('main/runtimeKernel/storageRootResolver.ts');
  const { SessionPersister } = load('main/sessions/persister.ts');
  const { commitPickerModelConfiguration } = load('main/agentSession/host/settings.ts');
  const { readHarnessPickerCatalog, setPickerModelConfiguration, listHarnessPickerChoices } = load('main/agentSession/harnessPickerCatalog.ts');
  const dispatch = load('main/agent/orchestrator/contextStatus.ts');
  const { primePiCatalogSnapshot } = load('main/agent/piConfigSync.ts');
  const storage = userDataStorage(profile);
  const legacyModel = { providerId: 'legacy-provider', modelId: 'legacy-model' };
  fs.writeFileSync(storage.file('agent-models'), JSON.stringify({ other: legacyModel }));
  fs.writeFileSync(storage.file('agent-thinking'), JSON.stringify({ other: 'low' }));
  const store = new Store();
  const cache = new ModelCatalogCache('claude');
  const key = (cwd, isolate = false) => JSON.stringify([cwd, claude.claudeConfigDirectory(profile, isolate), isolate]);
  const model = (modelId) => ({ providerId: 'claude', modelId });
  const native = (id, levels) => ({ id, name: 'Claude model', effortLevels: levels });
  const seed = [native('default-test', ['low']), native('backup-test', ['high']), native('backup-test', ['high'])];
  configureModelCatalogStorage(profile);
  cache.set(key(source), seed);
  configureModelCatalogStorage(profile);

  const scope = { workspaceId: 'fixture', rootId: 'root', rootsRevision: 2, cwd: source };
  const harness = { harnessId: 'claude', runtimeId: 'claude', surface: 'gui' };
  const cfg = { workspace: source, activeWorkspaceId: 'fixture', workspaces: [{ id: 'fixture', name: 'Fixture', path: source,
    roots: [{ id: 'root', path: source }], defaultRootId: 'root', rootsRevision: 2 }], modelParameterProfiles: [],
    llm: { activeProviderId: 'fixture-provider', activeModelId: 'dispatch-one', providers: [{ id: 'fixture-provider', name: 'Fixture',
      baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', thinking: { levels: { high: 'high' } }, models: [
        { id: 'dispatch-one', name: 'Dispatch one' }, { id: 'dispatch-two', name: 'Dispatch two', reasoning: true }
      ] }] } };
  const row = { id: 'gui-worker', name: 'Worker', runtime: 'claude', type: 'terminal', createdAt: 1, cwd: worktree,
    worktreePath: worktree, worktreeSource: { mainRepo: source }, modelOverride: model('default-test'), modelParameters: { reasoning: 'low' } };
  const runtimes = [{ id: 'claude', label: 'Claude', surface: 'chat', enabled: true }, { id: 'codex-gui', label: 'Codex', surface: 'chat', enabled: true },
    { id: 'pi', label: 'Core', surface: 'chat', enabled: false }];
  const driver = { runtimeId: 'claude', modelOverridePolicy: 'reconnect', connectionVersion: 'fixture-version' };
  const ctx = { config: { get: () => cfg }, store, getWindow: () => null, sessions: { get: id => id === row.id ? row : undefined,
    isChatRuntime: runtime => runtimes.some(item => item.id === runtime) }, runtimes: { rootDir: path.join(profile, 'runtimes'),
    list: () => runtimes, get: id => runtimes.find(item => item.id === id) } };
  const host = { ctx, entries: new Map(), drivers: new Map([[driver.runtimeId, driver]]) };
  const registryAst = ts.createSourceFile('sessions.ts', fs.readFileSync(path.join(root, 'src/main/sessions.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const registryClass = registryAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionsService');
  const commit = registryClass.members.find(node => node.name?.getText(registryAst) === 'commitModelConfiguration').getText(registryAst);
  const Registry = new Function(compile(`return class { ${commit} }`, 'fixture-registry.ts'))();
  const registry = Object.assign(new Registry(), { peek: ctx.sessions.get, persister: new SessionPersister(store, () => [row]) });
  ctx.sessions.commitModelConfiguration = registry.commitModelConfiguration.bind(registry);
  ctx.agentSessions = {
    getDriver: id => host.drivers.get(id), modelAdmission: { selections: { read: () => ({}) } },
    probeRuntime: async id => ({ status: id === 'codex-gui' ? 'not_installed' : 'available', problems: [] }),
    describePickerModelParameters: async target => {
      const catalog = await originalClaudeRead({ cwd: target.cwd, userDataDir: profile, isolateConfig: cfg.claude?.isolateConfig === true });
      const nativeModel = catalog.ok && catalog.items.find(item => item.id === target.modelId);
      return { ...target, parameters: nativeModel ? [{ id: 'reasoning', semantic: 'reasoning', label: 'Effort',
        options: nativeModel.effortLevels.map(value => ({ value, label: value })), supportsDefault: true, apply: 'reconnect' }] : [],
        ...(!nativeModel ? { unavailable: true } : {}) };
    },
    validateLaunchModel: async (_runtime, cwd) => assert.equal(cwd, source),
    commitPickerModelConfiguration: (...args) => commitPickerModelConfiguration(host, ...args)
  };

  let discoveries = 0;
  let duringRefresh;
  claude.listClaudeModels = async input => {
    if (!input.refresh) return originalClaudeRead(input);
    discoveries++;
    await duringRefresh?.();
    cache.set(key(input.cwd, input.isolateConfig), seed);
    return originalClaudeRead({ ...input, refresh: false });
  };
  let requests = 0;
  const read = (query) => readHarnessPickerCatalog(ctx, { requestId: `fixture-${++requests}`, ...query }, new AbortController().signal);
  const readSession = async (args = {}) => (await read({ sessionId: row.id, ...args })).catalog;
  const readLaunch = async (args = {}) => (await read({ source: scope, harness, ...args })).catalog;
  const launch = await readLaunch();
  const current = await readSession({ model: model('default-test') });
  const reference = await readLaunch({ model: model('default-test') });
  assert.equal(discoveries, 0, 'restart reads the existing cache in every picker mode');
  assert.equal(current.source.cwd, source, 'legacy isolated session resolves the registered source, not its worktree');
  assert.deepEqual(launch.models, current.models);
  assert.deepEqual(reference.models, current.models);
  assert.deepEqual(current.models.map(item => item.modelId), ['default-test', 'backup-test'], 'identical identities dedupe');
  assert.notEqual(current.models[0].detail, current.models[1].detail, 'aliases with identical display labels stay distinguishable');
  assert.equal(current.parameters[0].override, 'low');
  assert.equal((await readLaunch({ source: { ...scope, cwd: nested } })).state, 'missing', 'nested source never reads the parent directory cache');
  const availability = await listHarnessPickerChoices(ctx);
  assert.ok(availability.choices.some(choice => choice.runtimeId === 'claude' && choice.available));
  assert.ok(!availability.choices.some(choice => choice.runtimeId === 'codex-gui'));

  const refreshed = await readSession({ model: model('backup-test'), refresh: true });
  assert.equal(discoveries, 1);
  assert.equal(current.sessionStamp, refreshed.sessionStamp, 'a user refresh does not invalidate the unchanged draft binding');
  assert.notEqual(current.commitStamp, refreshed.commitStamp);
  assert.deepEqual(refreshed.parameters[0].descriptor.options.map(option => option.value), ['high']);
  cache.set(key(nested), seed);
  assert.equal((await readSession()).commitStamp, refreshed.commitStamp, 'another cwd on the same adapter does not invalidate the ticket');
  const oldInput = { sessionId: row.id, expected: current.commitStamp, model: model('backup-test'), parameters: { reasoning: 'high' } };
  await assert.rejects(setPickerModelConfiguration(ctx, oldInput), /已变化/);
  const input = { ...oldInput, expected: refreshed.commitStamp };
  await assert.rejects(setPickerModelConfiguration(ctx, { ...input, parameters: { reasoning: 'low' } }), /不支持/);
  assert.deepEqual(row.modelOverride, model('default-test'));
  const saved = await setPickerModelConfiguration(ctx, input);
  assert.equal(saved.ok, true);
  assert.deepEqual(store.loadSessions()[0].modelParameters, { reasoning: 'high' });
  assert.deepEqual(store.loadSessions()[0].modelOverride, model('backup-test'));

  const prior = await readSession();
  duringRefresh = async () => { row.modelParameters = {}; };
  await assert.rejects(readSession({ refresh: true }), /已变化/, 'a user edit during refresh makes the result stale');
  duringRefresh = undefined;
  await assert.rejects(setPickerModelConfiguration(ctx, { ...input, expected: prior.commitStamp }), /已变化/);
  const beforeStrict = await readSession();
  const originalStrict = store.saveSessionsStrict.bind(store);
  store.saveSessionsStrict = (snapshot, commit) => originalStrict(() => {
    cache.set(key(source), seed);
    return snapshot();
  }, commit);
  await assert.rejects(setPickerModelConfiguration(ctx, { ...input, expected: beforeStrict.commitStamp }), /已变化/);
  assert.deepEqual(row.modelParameters, {}, 'a refresh while waiting to write must leave the live configuration intact');

  await primePiCatalogSnapshot({ getBuiltinProviders: () => [], getBuiltinModels: () => [] });
  const bucket = { providerId: 'fixture-provider', modelId: 'dispatch-one', busy: true };
  const selected = { providerId: 'fixture-provider', modelId: 'dispatch-two' };
  const orchestration = { ctx, workspaceId: 'fixture', buckets: new Map([['fixture', bucket]]), models: store.loadAgentModels(), thinkings: store.loadAgentThinking(),
    getThinkingLevel: wsId => orchestration.thinkings[wsId] ?? null, isBusy: () => bucket.busy, invalidatePiSession() {}, emitContextStatus() {} };
  ctx.orchestrator = { getPickerConfiguration: (...args) => dispatch.getPickerConfiguration(orchestration, ...args) };
  const dispatchCatalog = (await read({ dispatch: { workspaceId: 'fixture' }, model: selected })).catalog;
  const dispatchModel = dispatchCatalog.models.find(item => item.modelId === selected.modelId);
  assert.equal(dispatchModel.label, 'Dispatch two');
  assert.deepEqual(dispatchModel.group, { id: 'fixture-provider', label: 'Fixture' });
  ctx.coreReasoningCatalog = { version: 1 };
  const staleDispatch = await dispatch.setPickerConfiguration(orchestration, 'fixture', selected, {
    expected: dispatchCatalog.commitStamp, parameters: { reasoning: 'high' }
  });
  assert.equal(staleDispatch.ok, false, 'a new reasoning catalog invalidates the dispatcher preview');
  const freshDispatch = (await read({ dispatch: { workspaceId: 'fixture' }, model: selected })).catalog;
  const dispatchOptions = { expected: freshDispatch.commitStamp, parameters: { reasoning: 'high' } };
  assert.equal((await dispatch.setPickerConfiguration(orchestration, 'fixture', selected, { ...dispatchOptions, parameters: { reasoning: 'max' } })).ok, false);
  assert.equal(bucket.modelId, 'dispatch-one');
  assert.deepEqual(await dispatch.setPickerConfiguration(orchestration, 'fixture', selected, dispatchOptions), { ok: true, applied: 'next-turn' });
  const restartedStore = new Store();
  assert.deepEqual(restartedStore.loadAgentModels().fixture, selected);
  assert.equal(restartedStore.loadAgentThinking().fixture, 'high');
  assert.deepEqual(restartedStore.loadAgentModels().other, legacyModel);
  assert.equal(restartedStore.loadAgentThinking().other, 'low');
  console.log('Unified Harness picker: persisted source, exact generations, strict session commit, and atomic scheduler settings passed');
} finally {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
}
