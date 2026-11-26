/** Compare the six configured Core HTTP protocols against the receiving endpoint's bytes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-wire-'));
const bodies = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  bodies.push(Buffer.concat(chunks).toString());
  res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"fixture"}}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;
try {
  await build({ entryPoints: ['src/shared/modelRequest.ts', 'src/main/agent/piOutputLimit.ts', 'src/main/agentSession/modelRequestStore.ts', 'src/main/agentSession/drivers/pi/modelRequestCapture.ts'],
    outdir: root, entryNames: '[name]', bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
  const { captureModelRequests } = await import(pathToFileURL(path.join(root, 'modelRequestCapture.mjs')));
  const { compressionFields, schedulerModelRequestId } = await import(pathToFileURL(path.join(root, 'modelRequest.mjs')));
  const { listModelRequests, readModelRequest, setModelRequestRecording } = await import(pathToFileURL(path.join(root, 'modelRequestStore.mjs')));
  const runtime = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(root, 'models'), allowModelNetwork: false, refreshOnCreate: false });
  const { useProviderOutputDefaults } = await import(pathToFileURL(path.join(root, 'piOutputLimit.mjs')));
  const apis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'mistral-conversations', 'azure-openai-responses', 'google-generative-ai'];
  useProviderOutputDefaults(runtime, apis.map(provider => ({ provider, id: 'fixture' })));
  const errors = [];
  const stop = captureModelRequests(runtime, root, 'test-session', error => errors.push(error));
  try {
    setModelRequestRecording(root, 'test-session', true);
    for (const api of apis) {
      runtime.registerProvider(api, { api, baseUrl: baseUrl + '/v1', apiKey: 'fixture-key',
        models: [{ id: 'fixture', name: 'fixture', input: ['text'], contextWindow: 64000, maxTokens: 512,
          reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
      const previous = bodies.length;
      const checkpoint = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n[Core L1 · evidence: core_context status/search/read]\nfixture\n</summary>';
      const excerpt = '[Core excerpt · source abcdef12 · 8192 chars · core_context read]\nretained line';
      const response = await runtime.completeSimple(runtime.getModel(api, 'fixture'), {
        messages: [{ role: 'user', content: checkpoint, timestamp: Date.now() },
          { role: 'assistant', api, provider: api, model: 'fixture', stopReason: 'toolUse', timestamp: Date.now(),
            usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
            content: [{ type: 'toolCall', name: 'read', id: 'call_abcdef123', arguments: {} }] },
          { role: 'toolResult', toolCallId: 'call_abcdef123', toolName: 'read', content: [{ type: 'text', text: excerpt }], isError: false, timestamp: Date.now() }]
      }, { maxRetries: 0, timeoutMs: 5000 });
      assert.ok(bodies.length > previous, api + ': ' + response.errorMessage);
      const rows = listModelRequests(root, 'test-session').filter(row => row.protocol === api).reverse();
      assert.equal(rows.length, bodies.length - previous, api);
      for (const [i, row] of rows.entries()) {
        assert.equal(row.complete, true);
        assert.equal(readModelRequest(root, 'test-session', row.id), bodies[previous + i], api);
        assert.equal(readModelRequest(root, 'other-session', row.id), null);
      }
      const payload = JSON.parse(bodies.at(-1));
      assert.deepEqual([...compressionFields(payload).values()], [checkpoint, excerpt], api + ' wire fields');
      const cap = p => p.max_completion_tokens ?? p.max_tokens ?? p.max_output_tokens ?? p.generationConfig?.maxOutputTokens;
      assert.equal(cap(payload), api === 'anthropic-messages' ? 512 : undefined, api + ' automatic');
      const count = bodies.length;
      await runtime.completeSimple(runtime.getModel(api, 'fixture'), {
        messages: [{ role: 'user', content: 'explicit output limit', timestamp: Date.now() }]
      }, { maxRetries: 0, timeoutMs: 5000, maxTokens: 257 });
      assert.ok(bodies.length > count);
      assert.equal(cap(JSON.parse(bodies.at(-1))), 257, api + ' explicit');
      console.log(api + ': wire body and automatic/explicit output limits matched');
    }
    await fetch(baseUrl + '/v1/chat/completions', { method: 'POST', body: 'unrelated tool fetch' });
    assert.equal(listModelRequests(root, 'test-session').length, bodies.length - 1);

    const scheduler = await ModelRuntime.create({ authPath: path.join(root, 'auth.json'), modelsPath: null,
      modelsStorePath: path.join(root, 'models'), allowModelNetwork: false, refreshOnCreate: false });
    scheduler.registerProvider('scheduler-fixture', { api: 'openai-completions', baseUrl: baseUrl + '/v1', apiKey: 'fixture-key',
      models: [{ id: 'dispatch-fixture', name: 'dispatch', input: ['text'], contextWindow: 64000, maxTokens: 512,
        reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const schedulerId = schedulerModelRequestId('workspace-fixture');
    const stopScheduler = captureModelRequests(scheduler, root, schedulerId, error => errors.push(error));
    const send = (modelRuntime, model, text) => modelRuntime.completeSimple(model, {
      messages: [{ role: 'user', content: text, timestamp: Date.now() }]
    }, { maxRetries: 0, timeoutMs: 5000 });
    const workerModel = runtime.getModel('openai-completions', 'fixture');
    const schedulerModel = scheduler.getModel('scheduler-fixture', 'dispatch-fixture');
    try {
      setModelRequestRecording(root, schedulerId, true);
      assert.equal(fs.readdirSync(path.join(root, 'agent-inputs')).includes(schedulerId), false);
      await Promise.all([send(runtime, workerModel, 'worker request'), send(scheduler, schedulerModel, 'scheduler request')]);
      const [workerCall] = listModelRequests(root, 'test-session');
      const [schedulerCall] = listModelRequests(root, schedulerId);
      assert.equal(listModelRequests(root, schedulerId).length, 1);
      assert.equal(readModelRequest(root, 'test-session', workerCall.id), bodies.find(body => body.includes('worker request')));
      assert.equal(readModelRequest(root, schedulerId, schedulerCall.id), bodies.find(body => body.includes('scheduler request')));
      assert.equal(readModelRequest(root, 'test-session', schedulerCall.id), null);
      stopScheduler();
      await Promise.all([send(runtime, workerModel, 'worker still recording'), send(scheduler, schedulerModel, 'retired scheduler runtime')]);
      assert.equal(listModelRequests(root, schedulerId).length, 1);
      const [nextWorkerCall] = listModelRequests(root, 'test-session');
      assert.equal(readModelRequest(root, 'test-session', nextWorkerCall.id), bodies.find(body => body.includes('worker still recording')));
    } finally { stopScheduler(); }
    assert.deepEqual(errors, []);
  } finally { stop(); }
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
