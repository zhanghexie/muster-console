import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-catalog-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { fetchProviderModelCatalog, ProviderModelCatalogStore } = await import(pathToFileURL(compile('main/agent/providerModelCatalog.ts')));
const { builtinProviders, getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');
const { primePiCatalogSnapshot, getPiCatalogForUi } = await import(pathToFileURL(compile('main/agent/piConfigSync.ts')));
await primePiCatalogSnapshot({ getBuiltinProviders: () => ['native'], getBuiltinModels: () => [{ id: 'native-model', api: 'google-generative-ai' }],
  builtinProviders: () => [{ id: 'native', name: 'Native', baseUrl: 'https://native.test/v1beta' }] });
assert.equal(getPiCatalogForUi().providers[0].api, 'google-generative-ai', 'extract protocol from the native model, not a provider-name heuristic');
const requests = [];
let mode = 'normal';
const server = http.createServer((req, res) => {
  requests.push({ url: req.url, headers: req.headers, method: req.method });
  const url = new URL(req.url, 'http://fixture');
  if (mode === 'missing') { res.writeHead(404).end(); return; }
  if (mode === 'error') { res.writeHead(401).end('invalid fixture-key'); return; }
  if (mode === 'redirect') { res.writeHead(302, { Location: '/elsewhere' }).end(); return; }
  let payload = { data: [{ id: 'new', name: 'New' }, { id: 'known' }, { id: 'new' }] };
  if (mode === 'deepseek') {
    if (url.pathname !== '/models') { res.writeHead(401).end('wrong model-list path'); return; }
    payload = { data: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1048576,
      max_output_tokens: 393216, input_modalities: ['text', 'image'], effort: { supported_levels: ['low', 'high', 'max'] } }] };
  }
  if (mode === 'empty') payload = { data: [] };
  if (mode === 'malformed') payload = { data: [{ id: 'valid' }, { name: 'missing-id' }] };
  if (mode === 'invalid') payload = { error: 'failure inside HTTP 200' };
  if (mode === 'pages') payload = url.searchParams.has('after_id')
    ? { data: [{ id: 'last', display_name: 'Last' }], has_more: false }
    : { data: [{ id: 'first' }], has_more: true, last_id: 'first' };
  if (mode === 'bad-page') {
    if (url.searchParams.has('after_id')) { res.writeHead(500).end('page failed'); return; }
    payload = { data: [{ id: 'first' }], has_more: true, last_id: 'first' };
  }
  if (mode === 'loop') payload = { data: [{ id: 'first' }], has_more: true, last_id: 'first' };
  if (mode === 'google') payload = url.searchParams.has('pageToken') ? { models: [{ name: 'models/gemini-last', displayName: 'Last', supportedGenerationMethods: ['generateContent'] }] }
    : { models: [{ name: 'models/gemini-new', displayName: 'New Gemini', inputTokenLimit: 1000000, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next' };
  if (mode === 'google-empty') payload = {};
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = { id: 'custom', baseUrl: origin, apiKey: ' fixture-key ' };

  // Exercise every built-in provider whose model-list protocol is supported by
  // the refresh implementation. The local server stands in for each provider;
  // no private key or real account data is read by this regression.
  const supported = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations']);
  const builtinCases = builtinProviders().map(item => ({ id: item.id, baseUrl: item.baseUrl, api: getBuiltinModels(item.id)[0]?.api }))
    .filter(item => typeof item.api === 'string' && supported.has(item.api));
  assert.ok(builtinCases.length >= 20, `expected the current built-in catalog to cover at least 20 refreshable providers, got ${builtinCases.length}`);
  for (const item of builtinCases) {
    mode = item.api === 'google-generative-ai' ? 'google' : 'normal';
    const pathname = typeof item.baseUrl === 'string' ? new URL(item.baseUrl).pathname : '';
    const result = await fetchProviderModelCatalog({ id: item.id, baseUrl: origin + pathname, apiKey: ' fixture-key ', api: item.api });
    assert.ok(result.models.length > 0, `${item.id} returned no candidate models`);
    const request = requests.at(-1);
    assert.equal(request.method, 'GET', `${item.id} uses a GET model-list request`);
    assert.equal(request.headers.authorization, item.api === 'anthropic-messages' || item.api === 'google-generative-ai' ? undefined : 'Bearer fixture-key');
    if (item.api === 'anthropic-messages') assert.equal(request.headers['x-api-key'], 'fixture-key');
    if (item.api === 'google-generative-ai') assert.equal(request.headers['x-goog-api-key'], 'fixture-key');
  }
  for (const api of [undefined, 'openai-completions', 'openai-responses', 'mistral-conversations']) {
    const result = await fetchProviderModelCatalog({ ...provider, api });
    assert.deepEqual(result.models.map(model => model.id), ['known', 'new']);
    assert.equal(requests.at(-1).url, '/v1/models'); assert.equal(requests.at(-1).method, 'GET');
    assert.equal(requests.at(-1).headers.authorization, 'Bearer fixture-key');
  }
  mode = 'deepseek';
  const requestsBeforeMissingDeepSeekKey = requests.length;
  await assert.rejects(fetchProviderModelCatalog({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '', api: 'openai-completions' }), /API Key/);
  assert.equal(requests.length, requestsBeforeMissingDeepSeekKey, 'DeepSeek without a key must fail before sending a request');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => realFetch(String(url).replace('https://api.deepseek.com', origin), options);
  const deepseek = await fetchProviderModelCatalog({ id: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: ' fixture-key ', api: 'openai-completions' });
  globalThis.fetch = realFetch;
  assert.equal(requests.at(-1).url, '/models', 'DeepSeek model discovery uses the official root endpoint');
  assert.deepEqual(deepseek.models[0], {
    id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576, maxTokens: 393216,
    input: ['text', 'image'], reasoning: true
  });
  for (const base of ['/anthropic/', '/anthropic/v1']) {
    mode = 'pages';
    const result = await fetchProviderModelCatalog({ ...provider, api: 'anthropic-messages', baseUrl: origin + base });
    assert.deepEqual(result.models.map(model => model.id), ['first', 'last']);
    assert.ok(requests.at(-1).url.startsWith('/anthropic/v1/models?after_id='));
    assert.equal(requests.at(-1).headers['x-api-key'], 'fixture-key');
    assert.equal(requests.at(-1).headers['anthropic-version'], '2023-06-01');
    assert.equal(requests.at(-1).headers.authorization, undefined);
  }
  mode = 'google';
  const google = await fetchProviderModelCatalog({ ...provider, api: 'google-generative-ai', baseUrl: origin + '/v1beta' });
  assert.deepEqual(google.models.map(model => model.id), ['gemini-last', 'gemini-new']);
  assert.equal(google.models[1].contextWindow, 1000000); assert.equal(google.models[1].maxTokens, 8192);
  assert.equal(requests.at(-1).url, '/v1beta/models?pageToken=next');
  assert.equal(requests.at(-1).headers['x-goog-api-key'], 'fixture-key'); assert.equal(requests.at(-1).headers.authorization, undefined);
  mode = 'google-empty';
  assert.deepEqual((await fetchProviderModelCatalog({ ...provider, api: 'google-generative-ai' })).models, []);

  mode = 'normal';
  const store = new ProviderModelCatalogStore(path.join(tmp, 'profile'));
  const before = requests.length;
  assert.equal(store.read(provider), null); assert.equal(requests.length, before, 'cache reads never fetch');
  const [first, duplicate] = await Promise.all([store.refresh(provider), store.refresh(provider)]);
  assert.deepEqual(first, duplicate); assert.equal(requests.length, before + 1, 'deduplicate concurrent refresh');
  const restored = new ProviderModelCatalogStore(path.join(tmp, 'profile'));
  assert.deepEqual(restored.read(provider), first);
  for (const changed of [{ id: 'another' }, { apiKey: 'other-key' }, { baseUrl: `${origin}/other` }, { api: 'anthropic-messages' }]) assert.equal(restored.read({ ...provider, ...changed }), null);
  assert.ok(!fs.readFileSync(path.join(tmp, 'profile', 'provider-model-catalogs.json'), 'utf8').includes('fixture-key'));
  for (const failure of ['missing', 'error', 'malformed', 'invalid', 'bad-page', 'loop', 'redirect']) {
    mode = failure;
    await assert.rejects(store.refresh(provider), error => { assert.ok(!error.message.includes('fixture-key')); return true; });
    assert.deepEqual(restored.read(provider), first, `${failure} preserves last complete snapshot`);
  }
  mode = 'empty';
  assert.deepEqual((await store.refresh(provider)).models, []);
  assert.deepEqual(restored.read(provider).models, [], 'successful empty list removes old candidates');
  const count = requests.length;
  for (const api of ['azure-openai-responses', 'bedrock-converse-stream', 'google-vertex']) await assert.rejects(fetchProviderModelCatalog({ ...provider, api }), /协议/);
  await assert.rejects(fetchProviderModelCatalog({ ...provider, baseUrl: '' }), /地址/);
  assert.equal(requests.length, count, 'unsupported protocols never send credentials');

  const actualFetch = globalThis.fetch;
  const actualSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (callback, delay, ...args) => actualSetTimeout(callback, delay === 12000 ? 10 : delay, ...args);
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    await assert.rejects(store.refresh(provider), /12秒/);
    assert.deepEqual(restored.read(provider).models, []);
  } finally { globalThis.fetch = actualFetch; globalThis.setTimeout = actualSetTimeout; }
  console.log('ok provider-model-catalog: real HTTP protocols, pagination, credential isolation, persistence, replacement, failure/timeout preservation');
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
