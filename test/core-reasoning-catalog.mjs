import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import * as piCatalog from '@earendil-works/pi-ai/providers/all';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'core-reasoning-'));
const compile = createSharedCompiler(process.cwd(), path.join(root, 'compiled'));
const load = entry => import(pathToFileURL(compile(entry)).href);
const signal = new AbortController().signal;
const originalFetch = globalThis.fetch;

try {
  const { bundledCoreReasoningCatalog: seed, findCoreReasoning, parseCoreReasoningCatalog,
    CORE_REASONING_CATALOG_URL, CoreReasoningCatalogStore } = await load('main/agent/coreReasoningCatalog.ts');
  const { configurePiReasoning, describeCoreReasoning } = await load('main/agent/piReasoning.ts');
  const { getConfiguredCoreReasoning, getConfiguredPiThinkingLevels, piReasoningSources,
    primePiCatalogSnapshot, syncPiConfigFromApp } = await load('main/agent/piConfigSync.ts');
  await primePiCatalogSnapshot(piCatalog);

  const providerFor = (row, id = row.providerId) => ({
    id, name: id, api: row.protocol, baseUrl: row.baseUrl, apiKey: 'fixture-key', models: [{ id: row.modelId, name: row.modelId }]
  });
  const deepseek = providerFor(seed.models[1]);
  deepseek.baseUrl = 'https://api.deepseek.com/';
  const openai = providerFor(seed.models[2], 'openai-responses');
  const qwen = providerFor(seed.models[3], 'my-qwen-plan');
  const tokenPlan = { ...providerFor(seed.models[4]), models: seed.models.slice(4).map(row => ({
    id: row.modelId, name: row.modelId, reasoning: false
  })) };
  const bindingFor = (provider, catalog = seed) => getConfiguredCoreReasoning(catalog, provider, provider.models[0]);
  const optionsFor = binding => describeCoreReasoning(binding).options.map(option => option.value);
  assert.deepEqual(describeCoreReasoning(bindingFor(deepseek)).options.map(option => option.value), ['off', 'low', 'high', 'max']);
  assert.deepEqual(describeCoreReasoning(bindingFor(openai)).options.map(option => option.value), ['medium', 'high', 'xhigh']);
  assert.deepEqual(describeCoreReasoning(bindingFor(qwen)).options.map(option => option.value), ['off', 'low', 'high', 'xhigh']);
  assert.equal(describeCoreReasoning(bindingFor(deepseek)).defaultValue, 'high');
  assert.equal(describeCoreReasoning(bindingFor(deepseek), 'max').defaultValue, 'max');
  assert.equal(describeCoreReasoning(bindingFor(deepseek), 'medium').defaultValue, 'high');
  assert.equal(bindingFor({ ...openai, api: 'openai-completions' }), undefined);
  assert.equal(bindingFor({ ...deepseek, baseUrl: 'https://gateway.example.com/v1' }), undefined);
  assert.equal(bindingFor({ ...qwen, baseUrl: qwen.baseUrl + '/different' }), undefined);
  assert.deepEqual(optionsFor(bindingFor({ ...deepseek, models: [{ ...deepseek.models[0], reasoning: false }] })),
    ['off', 'low', 'high', 'max'], 'endpoint capability overrides stale reasoning metadata');
  const preview = getConfiguredCoreReasoning(seed, tokenPlan, tokenPlan.models[0]);
  const deepseek1017 = getConfiguredCoreReasoning(seed, tokenPlan, tokenPlan.models[1]);
  assert.deepEqual(optionsFor(preview), ['off', 'low', 'medium', 'xhigh']);
  assert.equal(describeCoreReasoning(preview).defaultValue, 'xhigh');
  assert.deepEqual(optionsFor(deepseek1017), ['low', 'high', 'max']);
  assert.equal(describeCoreReasoning(deepseek1017).defaultValue, undefined);
  const gateway = { ...tokenPlan, baseUrl: 'https://gateway.example.com/v1', models: [{ ...tokenPlan.models[1], reasoning: true }] };
  assert.equal(bindingFor(gateway), undefined);
  assert.equal(getConfiguredPiThinkingLevels(gateway, gateway.models[0]), null, 'an unrelated endpoint cannot inherit a thinking menu');
  assert.deepEqual(getConfiguredPiThinkingLevels({ ...gateway, thinking: { levels: { high: 'hard' } } }, gateway.models[0]), ['high']);
  const sources = await piReasoningSources(() => ({ llm: { providers: [tokenPlan, openai, { ...qwen, enabled: false }] } }));
  assert.deepEqual(sources.providers.sort(), ['openai', 'qwen-token-plan-cn']);

  // Exhaustive across the SDK directory, unmodified by the six curated exceptions.
  let count = 0;
  for (const providerId of piCatalog.getBuiltinProviders()) {
    for (const model of piCatalog.getBuiltinModels(providerId)) {
      if (!model.baseUrl || model.baseUrl.includes('{')) continue; // requires an account-specific endpoint
      const configured = providerFor({ providerId, baseUrl: model.baseUrl, protocol: model.api, modelId: model.id });
      const expected = getSupportedThinkingLevels(model);
      const native = bindingFor(configured, { ...seed, models: [] });
      assert.deepEqual(native ? optionsFor(native) : [], expected.some(level => level !== 'off') ? expected : [],
        `${providerId}/${model.id}`);
      count++;
    }
  }
  assert.ok(count > 1400);
  const duplicateAlias = { ...seed.models[2], providerId: 'openai-alt' };
  const ambiguous = parseCoreReasoningCatalog({ ...seed, models: [...seed.models, duplicateAlias] });
  assert.equal(findCoreReasoning(ambiguous, openai, openai.api, openai.models[0].id), undefined);
  assert.equal(findCoreReasoning(ambiguous, { ...openai, id: duplicateAlias.providerId }, openai.api, openai.models[0].id).providerId, 'openai-alt');

  const next = structuredClone(seed);
  next.revision = '2026-11-19.2';
  next.updatedAt = '2026-11-19';
  next.models[3].reasoning.effort.push('turbo');
  const malformed = { ...next, models: [next.models[0], { ...next.models[1], reasoning: {
    ...next.models[1].reasoning, defaultEffort: 'unsupported'
  } }] };
  assert.throws(() => parseCoreReasoningCatalog(malformed), /Invalid Core reasoning capability/);
  assert.throws(() => parseCoreReasoningCatalog({ ...seed, models: [seed.models[0], seed.models[0]] }), /Duplicate/);

  const response = (catalog, etag) => new Response(JSON.stringify(catalog), { headers: { etag } });
  const queue = [response(next, '"next"'), new Response(null, { status: 304 }), response(malformed, '"bad"'), response(seed, '"seed"')];
  const pathToCache = path.join(root, 'cache', 'catalog.json');
  const requests = [];
  let changes = 0;
  const store = new CoreReasoningCatalogStore(pathToCache, () => changes++, async (url, init) => {
    requests.push({ url, init });
    return queue.shift();
  });
  assert.equal(store.snapshot.revision, seed.revision);
  const first = store.refresh(signal);
  assert.equal(store.refresh(signal), first, 'concurrent readers share one refresh');
  await first;
  assert.equal(store.snapshot.revision, next.revision);
  assert.equal(store.version, 1);
  assert.equal(changes, 1);
  assert.deepEqual(describeCoreReasoning(bindingFor(qwen, store.snapshot)).options.map(option => option.value), ['off', 'low', 'high', 'xhigh', 'turbo']);
  assert.equal(requests[0].url, CORE_REASONING_CATALOG_URL);
  assert.deepEqual(requests[0].init.headers, { Accept: 'application/json' });
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.redirect, 'error');

  await store.refresh(signal);
  assert.equal(requests[1].init.headers['If-None-Match'], '"next"');
  assert.equal(changes, 1, '304 keeps the current options');
  const warn = console.warn;
  const diagnostics = [];
  console.warn = (...values) => diagnostics.push(values.join(' '));
  try {
    await store.refresh(signal);
    assert.equal(store.snapshot.revision, next.revision);
    const offline = new CoreReasoningCatalogStore(pathToCache, () => {}, async () => { throw new Error('fixture offline'); });
    await offline.refresh(signal);
    assert.equal(offline.snapshot.revision, next.revision, 'restart can read the last validated snapshot offline');
    assert.deepEqual(offline.snapshot, store.snapshot);
    const coldOffline = new CoreReasoningCatalogStore(path.join(root, 'absent.json'), () => {}, async () => { throw new Error('fixture offline'); });
    await coldOffline.refresh(signal);
    assert.deepEqual(coldOffline.snapshot, seed, 'fresh install can use the bundled snapshot offline');
  } finally { console.warn = warn; }
  assert.equal(diagnostics.length, 3);
  await store.refresh(signal);
  assert.equal(requests[3].init.headers['If-None-Match'], '"next"', 'an invalid response cannot replace the persisted ETag');
  assert.equal(store.snapshot.revision, seed.revision, 'the host can roll back a publication');

  const staleFile = path.join(root, 'stale-before-upgrade.json');
  await fs.writeFile(staleFile, JSON.stringify({ catalog: { ...seed, revision: '2026-11-18.1', models: seed.models.slice(0, 4) } }));
  const stale = new CoreReasoningCatalogStore(staleFile, () => {}, async () => new Response(null, { status: 304 }));
  console.warn = () => {};
  try { await stale.refresh(signal); } finally { console.warn = warn; }
  assert.equal(stale.snapshot.revision, seed.revision, 'an older client cache cannot hide a newer bundled fix offline');

  const futureId = 'token-plan-future-fixture';
  const future = { ...tokenPlan, models: [{ id: futureId, reasoning: false }] };
  const supplied = { id: futureId, api: future.api, baseUrl: future.baseUrl, reasoning: true,
    headers: { Authorization: 'untrusted' },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: 'low', high: 'high', xhigh: 'max', max: null },
    compat: { thinkingFormat: 'qwen', supportsReasoningEffort: true, openRouterRouting: { order: ['untrusted'] } } };
  const generatedAt = Date.parse('2026-10-21T20:00:00Z');
  const shard = (row, modified = 'Thu, 19 Nov 2026 00:00:00 GMT') => new Response(JSON.stringify({ [futureId]: row }), {
    headers: { 'last-modified': modified, etag: '"pi-current"' }
  });
  const piResponses = [shard(supplied, 'Tue, 20 Oct 2026 00:00:00 GMT'), shard(supplied), new Response(null, { status: 304 }),
    shard({ ...supplied, thinkingLevelMap: { high: ['invalid'] } })];
  const piRequests = [];
  const piFile = path.join(root, 'pi-cache', 'core.json');
  let piChanges = 0;
  const piStore = new CoreReasoningCatalogStore(piFile, () => piChanges++, async (url, init) => {
    piRequests.push({ url, init });
    return piResponses.shift();
  });
  const refreshPi = () => piStore.refreshPiProvider(tokenPlan.id, generatedAt, signal);
  assert.equal(bindingFor(future, piStore.snapshot), undefined);
  const oldPi = refreshPi();
  assert.equal(refreshPi(), oldPi);
  await oldPi;
  assert.equal(piChanges, 0, 'an older shard cannot overlay packaged Pi data');
  await refreshPi();
  const futureBinding = bindingFor(future, piStore.snapshot);
  assert.deepEqual(optionsFor(futureBinding), ['medium', 'high', 'xhigh']);
  assert.deepEqual(futureBinding.native.compat, { thinkingFormat: 'qwen', supportsReasoningEffort: true });
  assert.equal(piStore.version, 1);
  await refreshPi();
  assert.equal(piChanges, 1);
  assert.equal(piRequests[2].url, 'https://pi.dev/api/models/providers/qwen-token-plan-cn?types=chat');
  assert.deepEqual(piRequests[2].init.headers, { Accept: 'application/json', 'If-None-Match': '"pi-current"' });
  assert.equal(piRequests[2].init.credentials, 'omit');
  assert.equal(piRequests[2].init.redirect, 'error');
  console.warn = () => {};
  try {
    await refreshPi();
    const restarted = new CoreReasoningCatalogStore(piFile, () => {}, async () => { throw new Error('fixture offline'); });
    await restarted.refreshPiProvider(tokenPlan.id, generatedAt, signal);
    assert.deepEqual(bindingFor(future, restarted.snapshot), futureBinding);
  } finally { console.warn = warn; }
  assert.deepEqual(bindingFor(future, piStore.snapshot), futureBinding, 'invalid responses preserve the last usable shard');

  const agentDir = path.join(root, 'pi');
  syncPiConfigFromApp({ providers: [deepseek, openai, qwen, { ...tokenPlan, models: [...tokenPlan.models, ...future.models] }],
    activeProviderId: deepseek.id, activeModelId: deepseek.models[0].id }, agentDir);
  const makeRuntime = () => ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'),
    modelsStorePath: path.join(root, 'models-store'), allowModelNetwork: false, refreshOnCreate: false });
  const runtime = await makeRuntime();
  const bodies = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.ok([new URL(deepseek.baseUrl).hostname, new URL(openai.baseUrl).hostname, new URL(qwen.baseUrl).hostname]
      .includes(new URL(request.url).hostname), 'no unrelated requests');
    bodies.push(await request.json());
    return new Response('{"error":{"message":"test captured the serialized request"}}', {
      status: 400, headers: { 'content-type': 'application/json' }
    });
  };
  const context = { messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }] };
  const send = async (control, value, mode, target = runtime) => {
    const previous = bodies.length;
    const reasoning = control.setLevel(value, mode);
    const result = await target.completeSimple(control.model, context, { maxRetries: 0, timeoutMs: 3000,
      ...(reasoning === 'off' ? {} : { reasoning }), onPayload: body => ({ ...body, user: 'fixture-hook' }) });
    assert.equal(bodies.length, previous + 1, result.errorMessage);
    assert.equal(bodies.at(-1).user, 'fixture-hook', 'SDK payload hooks are preserved');
    return bodies.at(-1);
  };
  const deepseekControl = configurePiReasoning(runtime, runtime.getModel(deepseek.id, deepseek.models[0].id), bindingFor(deepseek));
  for (const level of ['low', 'high', 'max']) {
    const payload = await send(deepseekControl, level);
    assert.equal(payload.reasoning_effort, level);
    assert.deepEqual(payload.thinking, { type: 'enabled' });
  }
  const deepseekOff = await send(deepseekControl, 'off');
  assert.deepEqual(deepseekOff.thinking, { type: 'disabled' });
  assert.equal(deepseekOff.reasoning_effort, undefined);
  const deepseekDefault = await send(deepseekControl);
  assert.equal(deepseekDefault.thinking, undefined);
  assert.equal(deepseekDefault.reasoning_effort, undefined);
  assert.equal((await send(deepseekControl, undefined, 'max')).reasoning_effort, 'max');
  assert.equal((await send(deepseekControl, 'retired')).reasoning_effort, undefined);

  const openaiControl = configurePiReasoning(runtime, runtime.getModel(openai.id, openai.models[0].id), bindingFor(openai));
  assert.equal((await send(openaiControl, 'xhigh')).reasoning.effort, 'xhigh');
  assert.equal((await send(openaiControl)).reasoning?.effort, undefined);
  assert.equal((await send(openaiControl, 'off')).reasoning?.effort, undefined);

  const qwenControl = configurePiReasoning(runtime, runtime.getModel(qwen.id, qwen.models[0].id), bindingFor(qwen, store.snapshot));
  const qwenOn = await send(qwenControl, 'xhigh');
  assert.equal(qwenOn.enable_thinking, true);
  assert.equal(qwenOn.reasoning_effort, 'xhigh');
  assert.equal((await send(qwenControl, 'off')).enable_thinking, false);
  assert.equal((await send(qwenControl)).enable_thinking, undefined);
  const previewControl = configurePiReasoning(runtime, runtime.getModel(tokenPlan.id, tokenPlan.models[0].id), preview);
  for (const level of ['low', 'medium', 'xhigh']) {
    const payload = await send(previewControl, level);
    assert.equal(payload.enable_thinking, true);
    assert.equal(payload.reasoning_effort, level);
  }
  assert.equal((await send(previewControl, 'off')).enable_thinking, false);
  assert.equal((await send(previewControl)).reasoning_effort, undefined);
  const deepseek1017Control = configurePiReasoning(runtime, runtime.getModel(tokenPlan.id, tokenPlan.models[1].id), deepseek1017);
  const tokenPlanMax = await send(deepseek1017Control, 'max');
  assert.equal(tokenPlanMax.enable_thinking, true);
  assert.equal(tokenPlanMax.reasoning_effort, 'max');
  assert.equal((await send(deepseek1017Control, 'medium')).reasoning_effort, undefined);
  const nativeControl = configurePiReasoning(runtime, runtime.getModel(future.id, futureId), futureBinding);
  assert.equal((await send(nativeControl, 'xhigh')).reasoning_effort, 'max', 'Pi serializes a newly published native mapping');
  assert.equal((await send(nativeControl)).reasoning_effort, 'low', 'native fallback uses the Pi session default');
  const refreshedRuntime = await makeRuntime();
  const updatedQwen = configurePiReasoning(refreshedRuntime, refreshedRuntime.getModel(qwen.id, qwen.models[0].id), bindingFor(qwen, next));
  assert.equal((await send(updatedQwen, 'turbo', undefined, refreshedRuntime)).reasoning_effort, 'turbo', 'a new enum value works without updating Pi');
  console.log('ok   Core reasoning catalog (SDK wire payloads, endpoint identity, remote cache, rollback)');
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(root, { recursive: true, force: true });
}
