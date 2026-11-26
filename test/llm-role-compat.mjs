/** Unknown compatible endpoints must not receive an undeclared developer role. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-role-compat-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const load = file => import(pathToFileURL(compile(file)).href);
  const { syncPiConfigFromApp, setPiCatalogSnapshot } = await load('main/agent/piConfigSync.ts');
  const { ConfigManager } = await load('main/config.ts');
  const { llmHost } = await load('main/capabilities/hosts/llm.ts');
  const provider = { id: 'relay', name: 'Relay', api: 'openai-completions', baseUrl: 'https://gateway.example.test/v1', apiKey: 'fixture-key',
    models: [{ id: 'reasoning-model', reasoning: true }] };
  const llm = p => ({ providers: [p], activeProviderId: p.id, activeModelId: p.models[0].id });
  const sync = p => {
    const dir = path.join(temp, 'core');
    syncPiConfigFromApp({ llm: llm(p) }, dir);
    return JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers[p.id];
  };
  async function role(p) {
    sync(p);
    const runtime = await ModelRuntime.create({ authPath: path.join(temp, 'core', 'auth.json'),
      modelsPath: path.join(temp, 'core', 'models.json'), modelsStorePath: path.join(temp, 'catalog-cache'),
      allowModelNetwork: false, refreshOnCreate: false });
    const model = runtime.getModel(p.id, p.models[0].id);
    assert.ok(model, runtime.getError() || 'SDK must resolve the configured model');
    let payload, requests = 0;
    const result = stream(model, normalizeContext({ systemPrompt: 'Follow the fixture instructions.',
      messages: [{ role: 'user', content: 'fixture', timestamp: 0 }] }), {
      apiKey: 'fixture-key', onPayload(value) { payload = value; throw new Error('fixture stops before network'); },
      fetch: async () => { requests++; throw new Error('fixture must not use the network'); }
    });
    await result.result();
    assert.equal(requests, 0);
    assert.ok(payload, 'exercise the real SDK request builder');
    return payload.messages[0].role;
  }
  assert.equal(await role(provider), 'system', 'custom endpoint must default to the standard system role');
  assert.equal(await role({ ...provider, compat: { supportsDeveloperRole: true } }), 'developer');
  assert.equal(await role({ ...provider, compat: { supportsDeveloperRole: false } }), 'system');
  assert.equal(await role({ ...provider, models: [{ id: 'plain-model', reasoning: false }], compat: { supportsDeveloperRole: true } }), 'system');
  assert.equal(sync({ ...provider, api: 'anthropic-messages', compat: { supportsDeveloperRole: true } }).compat, undefined);

  setPiCatalogSnapshot({ official: { 'reasoning-model': { reasoning: true, contextWindow: 32768, maxTokens: 4096 } } },
    [{ id: 'official', name: 'Official', baseUrl: 'https://official.example.test/v1', authMethods: ['apiKey'] }]);
  const official = { ...provider, id: 'official', baseUrl: 'https://official.example.test/v1' };
  assert.equal(sync(official).compat, undefined, 'catalog model compatibility must remain inherited');
  assert.deepEqual(sync({ ...official, compat: { supportsDeveloperRole: false } }).compat, { supportsDeveloperRole: false });
  assert.equal(await role({ ...official, baseUrl: provider.baseUrl }), 'system', 'a catalog id on a different endpoint is still a custom gateway');
  const catalogProvider = builtinProviders().find(meta => meta.baseUrl && getBuiltinModels(meta.id).some(model =>
    model.api === 'openai-completions' && model.reasoning && model.compat?.supportsDeveloperRole === false));
  assert.ok(catalogProvider, 'fixture needs a real catalog provider with a declared system-role model');
  const catalogModel = getBuiltinModels(catalogProvider.id).find(model =>
    model.api === 'openai-completions' && model.reasoning && model.compat?.supportsDeveloperRole === false);
  setPiCatalogSnapshot({ [catalogProvider.id]: { [catalogModel.id]: catalogModel } },
    [{ id: catalogProvider.id, name: catalogProvider.id, baseUrl: catalogProvider.baseUrl, authMethods: ['apiKey'] }]);
  const realOfficial = { ...provider, id: catalogProvider.id, baseUrl: catalogProvider.baseUrl,
    models: [{ id: catalogModel.id, reasoning: true }] };
  assert.equal(await role(realOfficial), 'system', 'the real runtime inherits the catalog model compatibility');
  assert.equal(await role({ ...realOfficial, compat: { supportsDeveloperRole: true } }), 'developer', 'explicit provider settings override catalog defaults');
  assert.equal(await role({ ...realOfficial, models: [{ id: 'unlisted-model', reasoning: true }] }), 'system', 'an unlisted model has no declared developer-role capability');
  assert.equal(await role({ ...realOfficial, models: [{ id: 'unlisted-model', reasoning: true }], compat: { supportsDeveloperRole: true } }), 'developer');
  setPiCatalogSnapshot({ official: { 'reasoning-model': { reasoning: true } } });
  assert.deepEqual(sync({ ...official, baseUrl: provider.baseUrl }).compat, { supportsDeveloperRole: false }, 'missing endpoint metadata cannot prove developer support');

  const config = new ConfigManager();
  for (const value of [false, true]) {
    config.update({ llm: llm({ ...provider, compat: { supportsDeveloperRole: value } }) });
    assert.deepEqual(new ConfigManager().get().llm.providers[0].compat, { supportsDeveloperRole: value }, 'load/save preserves explicit false as well as true');
  }
  const ctx = { config };
  llmHost['llm.upsertProvider'](ctx, { id: provider.id, compat: { supportsDeveloperRole: false } });
  llmHost['llm.upsertProvider'](ctx, { id: provider.id, name: 'Renamed relay' });
  assert.deepEqual(llmHost['llm.listProviders'](ctx).providers[0].compat, { supportsDeveloperRole: false });
  assert.equal(llmHost['llm.listProviders'](ctx).providers[0].apiKey, '***configured***');
  assert.throws(() => llmHost['llm.upsertProvider'](ctx, { id: provider.id, compat: { supportsDeveloperRole: 'false' } }), /compat/);
  llmHost['llm.upsertProvider'](ctx, { id: provider.id, compat: { supportsDeveloperRole: null } });
  assert.equal(config.get().llm.providers[0].compat, undefined, 'null clears an override');
  assert.equal(await role(config.get().llm.providers[0]), 'system');
  console.log('llm-role-compat: SDK payload roles, catalog inheritance, persistence and tool edits passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
