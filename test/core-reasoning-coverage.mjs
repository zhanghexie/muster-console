import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import * as pi from '@earendil-works/pi-ai/providers/all';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { buildModelReasoningCatalog } from '../scripts/build-core-reasoning-catalog.mjs';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-reasoning-coverage-'));
const compile = createSharedCompiler(process.cwd(), path.join(root, 'compiled'));
const load = entry => import(pathToFileURL(compile(entry)).href);
const originalFetch = globalThis.fetch;
const signal = new AbortController().signal;

try {
  const { CoreReasoningCatalogStore, CORE_EXPANDED_CATALOG_URL, parseExpandedReasoningCatalog } = await load('main/agent/coreReasoningCatalog.ts');
  const { getConfiguredCoreReasoning, getPiCatalogForUi, primePiCatalogSnapshot, syncPiConfigFromApp, piReasoningSources } = await load('main/agent/piConfigSync.ts');
  const { configurePiReasoning, describeCoreReasoning } = await load('main/agent/piReasoning.ts');
  await primePiCatalogSnapshot(pi);

  const route = (id, baseUrl, modelId) => ({ id, name: id, baseUrl, api: 'openai-completions', apiKey: 'fixture-key', models: [{ id: modelId }] });
  const silicon = route('siliconflow', 'https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-R1');
  const dashscope = route('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus');
  const bigmodel = route('zhipu', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.2');
  const moonshot = route('moonshot', 'https://api.moonshot.cn/v1', 'kimi-k2.6');
  const ollama = route('ollama', 'http://127.0.0.1:11434/v1', 'deepseek-r1:14b');
  const local = { providerId: ollama.id, baseUrl: ollama.baseUrl, modelId: ollama.models[0].id };
  const model = (provider, pkg, reason) => ({ id: provider.models[0].id, capabilities: { reasoning: { supported: true, ...reason } },
    api: { 'chat-completions': { base_url: provider.baseUrl, sdk: { opencodeai: `@opencode/ai/providers/${pkg}` } } } });
  const makeSource = model => ({ models: { [model.id]: model } });
  const source = {
    'siliconflow-cn': makeSource(model(silicon, 'openai-compatible', { budget: { min: 128, max: 32768 } })),
    'alibaba-cn': makeSource(model(dashscope, 'alibaba/chat', { budget: { max: 81920 }, toggle: true, default: { type: 'toggle', value: false } })),
    zhipuai: makeSource(model(bigmodel, 'zai/chat', { effort: ['high', 'max'], toggle: true, default: { type: 'effort', value: 'max' } })),
    'moonshotai-cn': makeSource(model(moonshot, 'moonshot/chat', { toggle: true })),
    unlisted: makeSource(model(route('unlisted', 'https://unlisted.invalid/v1', 'any'), 'alibaba/chat', { effort: ['max'] }))
  };
  source['alibaba-cn'].models['qwen-plus'].limit = { context: 32000 };
  source['alibaba-cn'].models['qwen-plus'].modalities = { input: ['text', 'image/png', 'video/mp4', 'application/pdf'] };
  const official = [{ providerId: dashscope.id, baseUrl: dashscope.baseUrl, protocol: dashscope.api,
    modelId: dashscope.models[0].id, contextWindow: 65536, input: ['text'], sources: ['https://official.example/models'] }];
  const document = buildModelReasoningCatalog(source, '2026-11-19.1', undefined, official);
  const expanded = parseExpandedReasoningCatalog(document);
  assert.equal(expanded.models.length, 5);
  const spec = expanded.capabilities.find(row => row.providerId === dashscope.id && row.modelId === 'qwen-plus');
  assert.deepEqual({ window: spec.contextWindow, input: spec.input, verified: spec.verified },
    { window: 65536, input: ['text'], verified: true });
  const upstreamInput = buildModelReasoningCatalog(source, '2026-11-19.1').capabilities.find(row => row.providerId === dashscope.id && row.modelId === 'qwen-plus');
  assert.deepEqual(upstreamInput.input, ['text', 'image', 'video', 'pdf']);
  assert.equal(upstreamInput.contextWindow, 32000);
  assert.equal(Object.values(expanded.pi).reduce((n, rows) => n + Object.keys(rows).length, 0),
    pi.getBuiltinProviders().flatMap(pi.getBuiltinModels).length);
  const bad = { ...document, models: [{ ...document.models[0], reasoning: { ...document.models[0].reasoning, budget: { min: -1, max: 1024 } } }] };
  assert.throws(() => parseExpandedReasoningCatalog(bad), /reasoning capability/);
  const badInput = { ...document, capabilities: [{ ...spec, input: ['text', 'invalid'] }] };
  assert.throws(() => parseExpandedReasoningCatalog(badInput), /model capability entry/);
  assert.throws(() => parseExpandedReasoningCatalog({ ...document, capabilities: [spec, { ...spec, baseUrl: `${spec.baseUrl}/` }] }), /Duplicate/);

  const queue = [
    new Response(JSON.stringify(document), { headers: { etag: '"v2"' } }),
    new Response(null, { status: 304 }),
    new Response(JSON.stringify(badInput)),
    new Response(JSON.stringify({ thinking: { values: [true, false], default: true } }))
  ];
  const requests = [];
  const cache = path.join(root, 'cache', 'catalog.json');
  const store = new CoreReasoningCatalogStore(cache, () => {}, async (url, init) => { requests.push([String(url), init]); return queue.shift(); });
  const planFor = (provider, snapshot = store.snapshot) => getConfiguredCoreReasoning(snapshot, provider, provider.models[0]);
  const levelsFor = binding => describeCoreReasoning(binding).options.map(o => o.value);
  assert.equal(planFor(silicon), undefined);
  await store.refreshExpanded(signal);
  assert.equal(requests[0][0], CORE_EXPANDED_CATALOG_URL);
  assert.equal(requests[0][1].credentials, 'omit');
  assert.deepEqual(requests[0][1].headers, { Accept: 'application/json' });
  assert.deepEqual(levelsFor(planFor(silicon)), ['budget-128', 'budget-16448', 'budget-32768']);
  assert.deepEqual(levelsFor(planFor(dashscope)), ['off', 'on', 'budget-1', 'budget-40960', 'budget-81920']);
  assert.equal(describeCoreReasoning(planFor(dashscope)).defaultValue, 'off');
  assert.deepEqual(levelsFor(planFor(bigmodel)), ['off', 'high', 'max']);
  assert.deepEqual(levelsFor(planFor(moonshot)), ['off', 'on']);
  assert.equal(planFor({ ...silicon, baseUrl: 'https://same-model.example/v1' }), undefined);
  assert.equal(planFor({ ...dashscope, models: [{ id: 'qwen4-max-preview' }] }), undefined, 'preview remains Token Plan only');
  await store.refreshExpanded(signal);
  assert.equal(store.version, 1);
  assert.equal(requests[1][1].headers['If-None-Match'], '"v2"');
  const warn = console.warn;
  console.warn = () => {};
  try {
    await store.refreshExpanded(signal);
    assert.equal(store.version, 1);
    const offline = new CoreReasoningCatalogStore(cache, () => {}, async () => { throw new Error('offline'); });
    await offline.refreshExpanded(signal);
    assert.deepEqual(planFor(silicon, offline.snapshot), planFor(silicon));
    assert.deepEqual(offline.snapshot.capabilities, store.snapshot.capabilities);
  } finally { console.warn = warn; }

  const legacyFolder = path.join(root, 'legacy');
  await fs.mkdir(legacyFolder);
  const { capabilities: _notCachedByOlderClient, ...legacyCatalog } = document;
  await fs.writeFile(path.join(legacyFolder, 'core-reasoning-v2.json'), JSON.stringify({ catalog: legacyCatalog, etag: '"v2"' }));
  const upgradeHeaders = [];
  const upgraded = new CoreReasoningCatalogStore(path.join(legacyFolder, 'reasoning-v1.json'), () => {}, async (_url, init) => {
    upgradeHeaders.push(init.headers);
    return init.headers['If-None-Match'] ? new Response(null, { status: 304 })
      : new Response(JSON.stringify(document), { headers: { etag: '"v2"' } });
  });
  await upgraded.refreshExpanded(signal);
  assert.equal(upgradeHeaders[0]['If-None-Match'], undefined, 'older clients cached the ETag without model specifications');
  assert.deepEqual(upgraded.snapshot.capabilities, expanded.capabilities);
  await upgraded.refreshExpanded(signal);
  assert.equal(upgradeHeaders[1]['If-None-Match'], '"v2"');

  const configured = { llm: { providers: [ollama, { ...ollama, id: 'ollama_1', baseUrl: 'https://example.invalid/v1' }] } };
  assert.deepEqual((await piReasoningSources(() => configured)).local, [local]);
  await store.refreshOllamaModel({ ...local, baseUrl: 'http://localhost.attacker.invalid/v1' }, signal);
  assert.equal(requests.length, 3);
  await store.refreshOllamaModel(local, signal);
  assert.equal(requests[3][0], 'http://127.0.0.1:11434/api/show');
  assert.equal(requests[3][1].redirect, 'error');
  assert.equal(requests[3][1].credentials, 'omit');
  assert.deepEqual(JSON.parse(requests[3][1].body), { model: 'deepseek-r1:14b' });
  assert.deepEqual(levelsFor(planFor(ollama)), ['off', 'on']);
  assert.equal(describeCoreReasoning(planFor(ollama)).defaultValue, 'on');

  const accountBases = {
    'amazon-bedrock': 'https://bedrock-runtime.us-west-2.amazonaws.com',
    azure: 'https://muster-fixture.openai.azure.com',
    'cloudflare-ai-gateway': 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/my-gateway/compat',
    'cloudflare-workers-ai': 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/v1',
    'google-vertex': 'https://us-central1-aiplatform.googleapis.com'
  };
  const ui = getPiCatalogForUi().providers.filter(p => p.authMethods.includes('apiKey') && p.models.length);
  const providers = new Map();
  let evaluated = 0;
  for (const { id, baseUrl, models } of ui) {
    const provider = { id, name: id, baseUrl: accountBases[id] ?? baseUrl, apiKey: 'fixture-key', models };
    for (const candidate of pi.getBuiltinModels(id)) {
      if (!getSupportedThinkingLevels(candidate).some(level => level !== 'off')) continue;
      const binding = getConfiguredCoreReasoning(store.snapshot, provider, candidate);
      assert.ok(binding, `${id}/${candidate.id} has a model-specific binding`);
      evaluated++;
    }
    const example = models.find(candidate => getConfiguredCoreReasoning(store.snapshot, provider, candidate));
    assert.ok(example, `${id} has an automatically configured reasoning model through its preset`);
    providers.set(id, { ...provider, models: [example] });
  }
  assert.ok(providers.size >= 40);
  for (const id of Object.keys(accountBases)) {
    const example = providers.get(id);
    assert.equal(planFor({ ...example, baseUrl: 'https://gateway.invalid/v1' }), undefined, `${id} metadata stays on the verified provider`);
  }
  const candidates = [silicon, dashscope, bigmodel, moonshot, ollama, ...Object.keys(accountBases).map(id => providers.get(id)),
    ...['opencode', 'opencode-go', 'radius'].map(id => providers.get(id))];
  const agentDir = path.join(root, 'sdk');
  syncPiConfigFromApp({ providers: candidates, activeProviderId: silicon.id, activeModelId: silicon.models[0].id }, agentDir);
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'),
    modelsStorePath: path.join(root, 'models-store'), allowModelNetwork: false, refreshOnCreate: false });
  const controls = new Map();
  for (const provider of candidates) {
    const registered = runtime.getModel(provider.id, provider.models[0].id);
    assert.ok(registered, `${provider.id} registers a usable SDK model`);
    controls.set(provider.id, configurePiReasoning(runtime, registered, planFor(provider)));
  }
  const payloads = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.ok([new URL(silicon.baseUrl).host, new URL(ollama.baseUrl).host, new URL(bigmodel.baseUrl).host].includes(new URL(request.url).host));
    payloads.push(await request.json());
    return new Response('{"error":{"message":"fixture captured serialized request"}}', { status: 400, headers: { 'content-type': 'application/json' } });
  };
  const send = async (provider, value) => {
    const control = controls.get(provider.id);
    const before = payloads.length;
    const reasoning = control.setLevel(value);
    const context = { messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }] };
    const result = await runtime.completeSimple(control.model, context, { maxRetries: 0, timeoutMs: 3000,
      ...(reasoning === 'off' ? {} : { reasoning }) });
    assert.equal(payloads.length, before + 1, result.errorMessage);
    return payloads.at(-1);
  };
  const budget = await send(silicon, 'budget-32768');
  assert.equal(budget.thinking_budget, 32768);
  assert.equal(budget.reasoning_effort, undefined);
  assert.equal(budget.enable_thinking, undefined);
  assert.equal((await send(silicon)).thinking_budget, undefined);
  assert.equal((await send(ollama, 'off')).reasoning_effort, 'none');
  assert.equal((await send(ollama, 'on')).reasoning_effort, 'medium');
  assert.equal((await send(ollama)).reasoning_effort, undefined);
  const glm = await send(bigmodel, 'max');
  assert.equal(glm.reasoning_effort, 'max');
  assert.deepEqual(glm.thinking, { type: 'enabled', clear_thinking: false });
  console.log(`ok expanded model catalog: ${evaluated} reasoning models across ${providers.size} Pi presets, supplemental endpoints, Ollama metadata, cache and actual SDK payloads`);
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(root, { recursive: true, force: true });
}
