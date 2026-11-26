/** Real provider lifecycle functions; SDK, workspace and filesystem business boundaries are offline fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const ts = createRequire(import.meta.url)('typescript');
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-connection-identity-'));

function declarations(file, names) {
  const source = fs.readFileSync(path.join(root, 'src', file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const found = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name ||
      ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(tree) === name));
    assert.ok(found, `${file}: ${name} exists`);
    return found.getText(tree);
  }).join('\n');
}

function instantiate(source, deps, names) {
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
  return new Function(...Object.keys(deps), 'exports', `${compiled}\nreturn {${names.join(',')}};`)(...Object.values(deps), {});
}

try {
  const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
  const load = file => import(pathToFileURL(compile(file)).href);
  const { llmConnectionIdentity } = await load('main/agent/llmConnectionIdentity.ts');
  const { resolveThinkingLevel, GUI_THINKING_LEVELS } = await load('shared/thinkingLevels.ts');
  const { getConfiguredCoreReasoning } = await load('main/agent/piConfigSync.ts');
  const { configurePiReasoning } = await load('main/agent/piReasoning.ts');
  const { safeCompactSession, safeSetThinkingLevel } = await load('shared/piEvents.ts');
  const t = key => key;
  const { resolveLlmConfig, resolveLlmConfigWithReload } = await load('main/config.ts');
  const configFunctions = { resolveLlmConfig, resolveLlmConfigWithReload };

  const names = ['sessionDeliveries', 'sessionRequestCaptures', 'sessionLlmIdentities', 'sessionReasoning', 'reasoningKey', 'activeTurnAborts', 'SETTLE_DRAIN_MS',
    'turnAbortKey', 'abortPiTurn', 'disposePiSessionResources', 'sessionModelReasoning', 'runPiTurn',
    'createPiSession', 'assertLlmConnectionCurrent', 'runPiProvider', 'runScopedPiProvider',
    'compactOrchestratorSession', 'compactScopedOrchestratorSession'];
  let providerSource = declarations('main/agent/providers/piProvider.ts', names);
  const importBoundary = "import('../../tasks/workerRouting')";
  assert.equal(providerSource.split(importBoundary).length, 2, 'only the routing module import is substituted');
  providerSource = providerSource.replace(importBoundary, 'loadWorkerRoutingFixture()');

  function fixture() {
    const base = { llm: { activeProviderId: 'selected', activeModelId: 'same-model', providers: [{
      id: 'selected', name: 'Selected', enabled: true, api: 'openai-completions',
      baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key-one', compat: { supportsDeveloperRole: false },
      thinking: { levels: { high: 'high' } }, models: [{ id: 'same-model', name: 'Display model',
        contextWindow: 32000, maxTokens: 2048, reasoning: true, multimodal: false }]
    }, { id: 'unrelated', name: 'Other', apiKey: 'unrelated-key', baseUrl: 'https://other.invalid',
      models: [{ id: 'other-model', name: 'Other model' }] }] } };
    let config = structuredClone(base), session = null, synced;
    const created = [], opened = [], compacted = [], contexts = new WeakMap(), deliveries = [], hooks = {};
    const workspace = { workspaceId: 'fixture', cwd: tmp, sourceRoot: { rootId: 'root', path: tmp, cwd: tmp } };
    const manager = file => ({ getSessionFile: () => file, getSessionId: () => 'fixture-session',
      buildSessionContext: () => ({ messages: [] }) });
    const pi = {
      SessionManager: {
        open(file) { opened.push(file); return manager(file); },
        create() { return manager(path.join(tmp, 'new-session.jsonl')); },
        continueRecent() { return manager(path.join(tmp, 'existing-session.jsonl')); }
      },
      ModelRuntime: { async create() {
        const snapshot = structuredClone(synced);
        await hooks.runtime?.();
        return { streamSimple() {}, getModel(providerId, modelId) {
          const resolved = configFunctions.resolveLlmConfig(snapshot, { providerId, modelId });
          return { ...resolved.model, provider: resolved.provider.id, api: resolved.provider.api, baseUrl: resolved.provider.baseUrl, connection: resolved };
        }, checkAuth: async () => true };
      } },
      async createAgentSession(input) {
        const row = { model: input.model, sessionManager: input.sessionManager, agent: {}, prompts: [], aborts: 0, disposals: 0,
          subscribe: () => () => {}, setThinkingLevel(level) { this.thinkingLevel = level; },
          async prompt(text) { this.prompts.push(text); this.isStreaming = true; try { await hooks.prompt?.(this); } finally { this.isStreaming = false; } },
          async abort() { this.aborts++; }, async dispose() { this.disposals++; },
          async compact(instructions) { compacted.push({ session: this, instructions }); return { summary: 'fixture summary', tokensBefore: 100 }; }
        };
        created.push(row);
        await hooks.create?.(row);
        return { session: row };
      }
    };
    const ctx = { config: { get: () => config, reloadFromDisk() { throw new Error('fixture must not read disk'); } },
      store: { getPiSessionDir: () => path.join(tmp, 'sessions') } };
    const deps = {
      ...configFunctions, llmConnectionIdentity, resolveThinkingLevel, GUI_THINKING_LEVELS, getConfiguredCoreReasoning, configurePiReasoning,
      safeCompactSession, safeSetThinkingLevel, t,
      console: { log() {}, warn() {}, error() {} }, pathJoin: path.join,
      loadPi: async () => { await hooks.load?.(); return pi; },
      app: { getPath: () => tmp }, userDataStorage: dir => ({ resolve: (_scope, purpose) => path.join(dir, purpose) }),
      bindSchedulerSessionContext: (_config, _manager, context) => context,
      captureSchedulerWorkspaceContext: () => workspace, beginSchedulerWorkspaceContext: () => () => {},
      assertWorkspaceExecutionContextCurrent() {}, getSchedulerConnectionContext: value => contexts.get(value),
      rememberSchedulerConnectionContext: (value, context) => contexts.set(value, context),
      primePiCatalogSnapshot: async () => { await hooks.catalog?.(); },
      syncPiConfigFromApp: value => { synced = structuredClone(value); return {}; },
      useProviderOutputDefaults() {},
      captureModelRequests: () => () => {},
      schedulerModelRequestId: id => `scheduler:${id}`,
      resolveEffectiveMcpFromApp: () => ({ enabled: false, servers: [] }), workspaceSkillPaths: () => [],
      schedulerTurnKindFromTurnScope: value => value, resolveTurnHiddenTools: () => ({}),
      buildMetaAgentAppendPrompt: () => [], requireShellApi: () => ({ baseUrl: 'http://fixture.invalid' }),
      SchedulerPiDelivery: class {
        constructor() { this.closed = false; deliveries.push(this); }
        attach() {} close() { this.closed = true; } endTurn() {}
      }, desktopEngineDeliveryFromContext: () => undefined,
      registerToolsFactory: async () => () => {}, createModeExtensionFactory: () => () => {}, ensureModeController: () => ({}),
      createCoreContextExtension: () => () => {}, CORE_CONTEXT_TOOL: 'core_context',
      createSchedulerDirectoryExtension: () => () => {}, createSchedulerWorkerRoutingExtension: () => () => {},
      loadWorkerRoutingFixture: async () => ({ summarizeWorkerRoutingTiers: () => [] }),
      createSkillSourceLoader: () => ({ getSkills: () => ({ skills: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        reload: async () => { await hooks.reload?.(); } }), schedulerProjectedCatalog: () => [], toApiName: name => name,
      installAttachmentPayload() {}, emitPiContext() {}, subscribePiReview: () => () => {}, subscribePiTurn: () => () => {},
      desktopTurnGrants: { observePiMessage() {} },
      runWithTurnUserText: (_text, run) => run(), runAsNonUserTurn: run => run(), runAsHeadlessTurn: run => run()
    };
    const api = instantiate(providerSource, deps, ['runPiProvider', 'compactOrchestratorSession']);
    const common = { ctx, getSession: () => session, setSession: value => { session = value; } };
    return { created, opened, compacted, hooks, deliveries, get session() { return session; },
      get config() { return config; }, change(fn) { const next = structuredClone(config); fn(next); config = next; },
      publish(models) { ctx.coreReasoningCatalog = { snapshot: { models } }; },
      run: () => api.runPiProvider({ ...common, workspaceId: 'fixture', text: 'offline task',
        assistant: { id: 'assistant', role: 'assistant', createdAt: 1, content: '' }, emit() {} }),
      compact: () => api.compactOrchestratorSession({ ...common, wsId: 'fixture', instructions: 'offline summary' }) };
  }

  const selected = config => config.llm.providers[0];
  for (const [label, change] of [
    ['compat', config => { selected(config).compat.supportsDeveloperRole = true; }],
    ['key', config => { selected(config).apiKey = 'fixture-key-two'; }],
    ['base URL', config => { selected(config).baseUrl = 'https://replacement.invalid/v1'; }],
    ['thinking mapping', config => { selected(config).thinking.levels.high = 'xhigh'; }],
    ['model settings', config => { selected(config).models[0].maxTokens = 4096; }]
  ]) {
    const f = fixture(); await f.run(); const previous = f.session;
    const file = previous.sessionManager.getSessionFile(); f.change(change); await f.run();
    assert.notEqual(f.session, previous, `${label}: same IDs must reconnect`);
    assert.equal(previous.disposals, 1); assert.equal(previous.aborts, 1);
    assert.equal(f.session.sessionManager.getSessionFile(), file, `${label}: conversation file is retained`);
    assert.deepEqual(f.opened, [file]);
    assert.equal(llmConnectionIdentity(f.session.model.connection), llmConnectionIdentity(configFunctions.resolveLlmConfig(f.config)));
    assert.equal(f.session.prompts.length, 1);
  }
  {
    const f = fixture(); await f.run(); const previous = f.session;
    f.change(config => { config.llm.providers[1].apiKey = 'unrelated-new'; selected(config).name = 'Renamed provider';
      selected(config).models[0].name = 'Renamed model'; selected(config).models.push({ id: 'unused', name: 'Unused' }); });
    await f.run(); assert.equal(f.session, previous); assert.equal(f.created.length, 1); assert.equal(previous.disposals, 0);
  }
  {
    const f = fixture(); let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    f.hooks.prompt = async () => { entered(); await gate; };
    const active = f.run(); await started; const previous = f.session;
    f.change(config => { selected(config).apiKey = 'key-during-turn'; });
    await Promise.resolve(); assert.equal(previous.aborts, 0); assert.equal(previous.disposals, 0, 'config edit does not interrupt a busy turn');
    release(); await active; delete f.hooks.prompt; await f.run();
    assert.notEqual(f.session, previous, 'the following turn reconnects');
  }
  {
    const f = fixture();
    const endpoint = selected(f.config);
    const binding = { providerId: endpoint.id, protocol: endpoint.api, baseUrl: endpoint.baseUrl, modelId: endpoint.models[0].id,
      reasoning: { format: 'deepseek', effort: ['low', 'high'], defaultEffort: 'high', canDisable: true } };
    f.publish([binding]);
    let enter, release;
    const started = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    f.hooks.prompt = async () => { enter(); await gate; };
    const active = f.run();
    await started;
    const previous = f.session;
    f.publish([{ ...binding, reasoning: { ...binding.reasoning, effort: ['low', 'high', 'max'], defaultEffort: 'max' } }]);
    assert.equal(previous.thinkingLevel, 'high');
    assert.equal(previous.disposals, 0, 'publishing a new catalog does not interrupt a busy turn');
    release();
    await active;
    delete f.hooks.prompt;
    await f.run();
    assert.notEqual(f.session, previous);
    assert.equal(f.session.thinkingLevel, 'max');
    assert.deepEqual(f.opened, [previous.sessionManager.getSessionFile()]);
  }
  for (const boundary of ['reload', 'create']) {
    const f = fixture();
    f.hooks[boundary] = async () => { f.change(config => { selected(config).apiKey = `key-after-${boundary}`; }); };
    await assert.rejects(f.run(), /配置.*变化/);
    assert.equal(f.session, null); assert.equal(f.created.reduce((sum, row) => sum + row.prompts.length, 0), 0);
    assert.equal(f.deliveries.every(delivery => delivery.closed), true);
    if (boundary === 'create') assert.equal(f.created[0].disposals, 1, 'the stale SDK session is disposed before publication');
    else assert.equal(f.created.length, 0, 'stale resource loading never creates an SDK session');
  }
  {
    const f = fixture(); await f.run(); const previous = f.session;
    const file = previous.sessionManager.getSessionFile();
    f.change(config => { selected(config).compat.supportsDeveloperRole = true; });
    assert.equal((await f.compact()).ok, true);
    assert.notEqual(f.session, previous); assert.equal(previous.disposals, 1);
    assert.equal(f.compacted[0].session, f.session); assert.equal(f.session.sessionManager.getSessionFile(), file);
    assert.equal(f.session.model.connection.provider.compat.supportsDeveloperRole, true);
    assert.equal(f.session.prompts.length, 0, 'compaction uses the new connection without sending a task prompt');
  }
  console.log('pi provider connection identity: real run/create/compact lifecycle passed with offline boundaries');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
