/** Selected Pi connection semantics and the real GUI driver's catalog-loading boundary. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-connection-identity-'));
const require = createRequire(import.meta.url), ts = require('typescript'), Module = require('node:module');
const previousTs = require.extensions['.ts'], previousLoad = Module._load;
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename
}).outputText, filename);
let releaseCatalog, catalogEntered;
const synced = [], workers = [];
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  if (parent?.filename.replaceAll('\\', '/').endsWith('/drivers/pi/driver.ts')) {
    if (request === '../../../agent/piConfigSync') return {
      ...previousLoad.call(this, request, parent, isMain),
      primePiCatalogSnapshot: () => new Promise(resolve => { releaseCatalog = resolve; catalogEntered(); }),
      syncPiConfigFromApp: config => synced.push(structuredClone(config))
    };
    if (request === './workerHost') return { createPiWorkerConnection: async (input, options) => {
      workers.push({ input, options }); return { close: async () => {} };
    } };
    if (request === './shellEnv') return { resolvePiShellEnv: () => ({ bashAvailable: true, settings: {} }) };
    if (request === '../../../shell/profiles') return { detectGitBashPath: () => undefined };
  }
  return previousLoad.call(this, request, parent, isMain);
};

try {
  const { llmConnectionIdentity } = require(path.join(root, 'src/main/agent/llmConnectionIdentity.ts'));
  const provider = { id: 'selected', name: 'Display', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-secret',
    models: [{ id: 'chosen', name: 'Chosen', contextWindow: 32000 }, { id: 'unused' }], compat: { supportsDeveloperRole: false } };
  const identity = value => llmConnectionIdentity({ provider: value, model: value.models[0] });
  const initial = identity(provider);
  assert.match(initial, /^[a-f0-9]{64}$/);
  assert.equal(initial.includes(provider.apiKey), false, 'credentials cannot appear in the connection key');
  for (const change of [
    p => { p.apiKey = 'rotated'; }, p => { p.baseUrl = 'https://other.invalid/v1'; },
    p => { p.api = 'openai-responses'; }, p => { p.enabled = false; },
    p => { p.thinking = { thinkingFormat: 'openai', levels: { high: 'high' } }; },
    p => { p.compat.supportsDeveloperRole = true; }, p => { delete p.compat; },
    p => { p.models[0].contextWindow = 64000; }, p => { p.models[0].maxTokens = 1024; },
    p => { p.models[0].reasoning = true; }, p => { p.models[0].multimodal = true; }
  ]) {
    const changed = structuredClone(provider); change(changed);
    assert.notEqual(identity(changed), initial, 'execution settings invalidate the selected connection');
  }
  const renamed = structuredClone(provider);
  renamed.name = 'New display'; renamed.models[0].name = 'New model display'; renamed.models[1].reasoning = true;
  renamed.api = 'openai-completions'; renamed.enabled = true;
  renamed.baseUrl += '/'; renamed.apiKey = ` ${renamed.apiKey} `;
  assert.equal(identity(renamed), initial, 'display, other models and equivalent defaults do not invalidate');
  const reordered = Object.fromEntries(Object.entries(provider).reverse());
  reordered.models = provider.models.map(model => Object.fromEntries(Object.entries(model).reverse()));
  assert.equal(identity(reordered), initial, 'property insertion order is not a configuration change');

  const { PiRuntimeDriver } = require(path.join(root, 'src/main/agentSession/drivers/pi/driver.ts'));
  let cfg = { llm: { providers: [structuredClone(provider), { ...structuredClone(provider), id: 'other' }],
    activeProviderId: provider.id, activeModelId: provider.models[0].id } };
  const driver = new PiRuntimeDriver({ config: { get: () => cfg, reloadFromDisk: () => cfg } }, { userDataDir: tmp });
  const input = { sessionId: 'fixture', cwd: tmp, modelOverride: { providerId: 'selected', modelId: 'chosen' } };
  const start = async () => {
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    catalogEntered = entered;
    const pending = driver.connect(input);
    await ready;
    return { pending };
  };
  const stale = await start();
  cfg = structuredClone(cfg); cfg.llm.providers[0].compat.supportsDeveloperRole = true;
  const rejected = assert.rejects(stale.pending, /模型连接配置在准备期间变化/);
  releaseCatalog(); await rejected;
  assert.equal(synced.length, 0, 'an obsolete selected configuration is not written after catalog await');
  assert.equal(workers.length, 0, 'an obsolete selected configuration never launches a worker');

  const unrelated = await start();
  cfg = structuredClone(cfg); cfg.llm.providers[1].apiKey = 'updated-other-key';
  releaseCatalog(); await unrelated.pending;
  assert.equal(workers.length, 1, 'other-provider changes do not reject the selected connection');
  assert.equal(synced.at(-1).llm.providers[1].apiKey, 'updated-other-key', 'sync preserves newer unrelated settings');
  assert.equal(synced.at(-1).llm.providers[0].compat.supportsDeveloperRole, true);

  const { resolveLlmConfig } = require(path.join(root, 'src/main/config.ts'));
  const { setPiCatalogSnapshot, setPublishedModelInputSpecifications } = require(path.join(root, 'src/main/agent/piConfigSync.ts'));
  delete cfg.llm.providers[0].models[0].contextWindow;
  const cold = resolveLlmConfig(cfg);
  const autoIdentity = llmConnectionIdentity(cold);
  assert.equal(cold.model.contextWindow, 1_000_000);
  const warming = await start();
  setPiCatalogSnapshot({
    relay: { chosen: { id: 'chosen', contextWindow: 200000 } },
    selected: { chosen: { id: 'chosen', contextWindow: 2000000 } }
  }, [{ id: 'selected', name: 'Selected', baseUrl: 'https://fixture.invalid/v1', authMethods: ['apiKey'] }]);
  releaseCatalog(); await warming.pending;
  const warm = resolveLlmConfig(cfg);
  assert.equal(warm.model.contextWindow, 2000000, 'prefer the selected provider’s window');
  assert.equal(autoIdentity, llmConnectionIdentity(warm), 'warming the catalog preserves the connection');
  const custom = resolveLlmConfig(cfg, { providerId: 'other' });
  assert.equal(custom.model.contextWindow, 32000, 'manual window overrides the catalog');
  delete cfg.llm.providers[1].models[0].contextWindow;
  assert.equal(resolveLlmConfig(cfg, { providerId: 'other' }).model.contextWindow, 1_000_000, 'a custom gateway uses its own endpoint defaults');
  const published = { providerId: 'selected', baseUrl: 'https://fixture.invalid/v1', protocol: 'openai-completions',
    modelId: 'chosen', contextWindow: 64000, input: ['text'], sources: ['https://fixture.invalid/docs'] };
  setPublishedModelInputSpecifications([published]);
  const online = resolveLlmConfig(cfg);
  assert.equal(online.model.contextWindow, 64000);
  assert.notEqual(llmConnectionIdentity(online), autoIdentity, 'publishing a selected model specification invalidates the connection');
  setPublishedModelInputSpecifications([{ ...published, sources: ['https://fixture.invalid/revised-docs'] }]);
  assert.equal(llmConnectionIdentity(resolveLlmConfig(cfg)), llmConnectionIdentity(online), 'source-only edits keep the connection');
  cfg.llm.providers[0].models[0].contextWindow = 1000000;
  assert.notEqual(llmConnectionIdentity(resolveLlmConfig(cfg)), autoIdentity, 'pinning a window is a configuration change');
  console.log('llm-connection-identity: ok');
} finally {
  Module._load = previousLoad;
  if (previousTs) require.extensions['.ts'] = previousTs; else delete require.extensions['.ts'];
  assert.ok(tmp.startsWith(path.join(os.tmpdir(), 'llm-connection-identity-')));
  fs.rmSync(tmp, { recursive: true, force: true });
}
