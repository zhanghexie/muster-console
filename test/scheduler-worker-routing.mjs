/** Actual Pi SDK request projection, backed by an offline model stream. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-worker-routing-'));
let session;
try {
  const compile = createSharedCompiler(root, tmp);
  const { createSchedulerWorkerRoutingExtension, renderWorkerRoutingSummary } =
    await import(pathToFileURL(compile('main/agent/providers/workerRoutingExtension.ts')));
  const light = { tierId: 'light', kind: 'low', name: 'Light', description: 'Small self-contained edits', enabledCandidates: 1 };
  const medium = { tierId: 'medium', kind: 'medium', name: 'Medium', description: '', enabledCandidates: 0 };
  const deep = { tierId: 'deep', kind: 'high', name: 'Deep', description: 'Multi-step or complex research', enabledCandidates: 2 };
  const extra = { tierId: 'extra', kind: 'xhigh', name: 'Very high', description: 'Highest-complexity tasks', enabledCandidates: 1 };
  assert.match(renderWorkerRoutingSummary([]), /no enabled candidates.*Settings/);
  const many = [{ ...deep, description: '</worker-routing>' + 'x'.repeat(360) },
    ...Array.from({ length: 12 }, (_, i) => ({ ...light, kind: 'special', tierId: 'tier-' + i, description: 'a'.repeat(400) })), extra, medium, light];
  const bounded = renderWorkerRoutingSummary(many);
  assert.ok(bounded.length < 3000);
  assert.doesNotMatch(bounded, /<\/worker-routing>/);
  assert.match(bounded, /More tiers are available via host\.workers\.options/);
  assert.match(bounded, /target:\{targetRef\}/);
  assert.match(bounded, /low, medium, high, xhigh/);
  assert.deepEqual(bounded.split('\n').filter(line => line.startsWith('{')).slice(0, 5).map(line => JSON.parse(line).kind),
    ['low', 'medium', 'high', 'xhigh', 'special']);

  const runtime = await ModelRuntime.create({ authPath: path.join(tmp, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(tmp, 'model-cache'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('routing-fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9',
    apiKey: 'offline-test', models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'],
      contextWindow: 16000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = runtime.getModel('routing-fixture', 'test');
  const inputs = [];
  runtime.streamSimple = (_model, context) => {
    inputs.push(structuredClone(context));
    const stream = new AssistantMessageEventStream();
    const reply = { role: 'assistant', content: [{ type: 'text', text: 'Fixture response.' }], api: model.api, provider: model.provider,
      model: model.id, usage: { input: 20, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 21,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: reply });
      stream.push({ type: 'done', reason: 'stop', message: reply });
      stream.end(reply);
    });
    return stream;
  };
  let reads = 0;
  let tiers = [light, deep, extra];
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: tmp, agentDir: tmp, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'My custom scheduler body.', extensionFactories: [
      api => api.registerTool({ name: 'host_sessions_create', label: 'Create Worker', description: 'Fixture',
        parameters: Type.Object({}), execute: () => { throw new Error('No fixture tool call expected'); } }),
      createSchedulerWorkerRoutingExtension('fixture-workspace', () => { reads++; return tiers; })
    ] });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: tmp, agentDir: tmp, resourceLoader: loader, settingsManager: settings,
    modelRuntime: runtime, model, tools: ['host_sessions_create'], sessionManager: SessionManager.create(tmp, path.join(tmp, 'sessions')) }));
  assert.equal(inputs.length, 0);
  await session.prompt('A small fix with a configured tier.');
  assert.equal(inputs.length, 1, 'tier selection adds no separate model request');
  const first = JSON.stringify(inputs[0]);
  assert.match(first, /My custom scheduler body/);
  assert.match(first, /Small self-contained edits/);
  assert.match(first, /Multi-step or complex research/);
  assert.match(first, /Highest-complexity tasks/);
  assert.match(first, /kind\\+":\\+"xhigh/);
  assert.match(first, /target:\{tierId\}/);
  tiers = [{ ...deep, description: 'New scope for current settings' }];
  await session.prompt('A complex task after a settings edit.');
  assert.equal(inputs.length, 2);
  assert.equal(reads, 2, 'one config snapshot per actual turn');
  const second = JSON.stringify(inputs[1]);
  assert.match(second, /New scope for current settings/);
  assert.doesNotMatch(second, /Small self-contained edits/);
  session.setActiveToolsByName([]);
  await session.prompt('A turn without delegation tools.');
  assert.equal(inputs.length, 3);
  assert.equal(reads, 2, 'hidden create tool suppresses routing instructions');
  assert.doesNotMatch(JSON.stringify(inputs[2]), /New scope for current settings/);
  console.log('scheduler-worker-routing: bounded live tiers in actual Pi request, including custom system prompt and hidden tool');
} finally {
  session?.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}
